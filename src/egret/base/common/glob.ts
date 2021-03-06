import { LRUCache } from 'egret/base/common/map';
import * as paths from 'egret/base/common/paths';
import * as strings from 'egret/base/common/strings';

import * as arrays from 'egret/base/common/arrays';

import { CharCode } from 'egret/base/common/charCode';


const T1 = /^\*\*\/\*\.[\w\.-]+$/; 						   			// **/*.something
const T2 = /^\*\*\/([\w\.-]+)\/?$/; 							   			// **/something
const T3 = /^{\*\*\/[\*\.]?[\w\.-]+\/?(,\*\*\/[\*\.]?[\w\.-]+\/?)*}$/; 	// {**/*.something,**/*.else} or {**/package.json,**/project.json}
const T3_2 = /^{\*\*\/[\*\.]?[\w\.-]+(\/(\*\*)?)?(,\*\*\/[\*\.]?[\w\.-]+(\/(\*\*)?)?)*}$/; 	// Like T3, with optional trailing /**
const T4 = /^\*\*((\/[\w\.-]+)+)\/?$/; 						   			// **/something/else
const T5 = /^([\w\.-]+(\/[\w\.-]+)*)\/?$/; 		

const GLOBSTAR = '**';
const GLOB_SPLIT = '/';
const PATH_REGEX = '[/\\\\]';		// any slash or backslash
const NO_PATH_REGEX = '[^/\\\\]';	// any non-slash and non-backslash
const ALL_FORWARD_SLASHES = /\//g;


interface SiblingsPattern { siblings: string[]; name: string; }
interface ParsedExpressionPattern {
	(path: string, basename: string, siblingsPatternFn: () => SiblingsPattern | Promise<SiblingsPattern>): string | Promise<string> /* the matching pattern */;
	requiresSiblings?: boolean;
	allBasenames?: string[];
	allPaths?: string[];
}


export interface IRelativePattern {
	base: string;
	pattern: string;
	pathToRelative(from: string, to: string): string;
}

export interface IGlobOptions {
	trimForExclusions?: boolean;
}

export interface IExpression {
	[pattern: string]: boolean | SiblingClause | any;
}


export interface SiblingClause {
	when: string;
}

const FALSE = function () {
	return false;
};

const NULL = function (): string {
	return null;
};


const CACHE = new LRUCache<string, ParsedStringPattern>(10000); // bounded to 10000 elements



interface ParsedStringPattern {
	(path: string, basename: string): string | Promise<string> /* the matching pattern */;
	basenames?: string[];
	patterns?: string[];
	allBasenames?: string[];
	allPaths?: string[];
}

export function match(pattern: string | IRelativePattern, path: string): boolean;
export function match(expression: IExpression, path: string, siblingsFn?: () => string[]): string /* the matching pattern */;
export function match(arg1: string | IExpression | IRelativePattern, path: string, siblingsFn?: () => string[]): any {
	if (!arg1 || !path) {
		return false;
	}

	return parse(<IExpression>arg1)(path, undefined, siblingsFn);
}


export interface IGlobOptions {
	trimForExclusions?: boolean;
}

export type ParsedPattern = (path: string, basename?: string) => boolean;

export type ParsedExpression = (path: string, basename?: string, siblingsFn?: () => string[] | Promise<string[]>) => string | Promise<string> /* the matching pattern */;

export function parse(pattern: string | IRelativePattern, options?: IGlobOptions): ParsedPattern;
export function parse(expression: IExpression, options?: IGlobOptions): ParsedExpression;
export function parse(arg1: string | IExpression | IRelativePattern, options: IGlobOptions = {}): any {
	if (!arg1) {
		return FALSE;
	}

	// Glob with String
	if (typeof arg1 === 'string' || isRelativePattern(arg1)) {
		const parsedPattern = parsePattern(arg1 as string | IRelativePattern, options);
		if (parsedPattern === null) {
			return FALSE;
		}
		const resultPattern = function (path: string, basename: string) {
			return !!parsedPattern(path, basename);
		};
		if (parsedPattern.allBasenames) {
			(<ParsedStringPattern><any>resultPattern).allBasenames = parsedPattern.allBasenames;
		}
		if (parsedPattern.allPaths) {
			(<ParsedStringPattern><any>resultPattern).allPaths = parsedPattern.allPaths;
		}
		return resultPattern;
	}

	// Glob with Expression
	return parsedExpression(<IExpression>arg1, options);
}



function parsedExpression(expression: IExpression, options: IGlobOptions): ParsedExpression {
	const parsedPatterns = aggregateBasenameMatches(Object.getOwnPropertyNames(expression)
		.map(pattern => parseExpressionPattern(pattern, expression[pattern], options))
		.filter(pattern => pattern !== NULL));

	const n = parsedPatterns.length;
	if (!n) {
		return NULL;
	}

	if (!parsedPatterns.some(parsedPattern => (<ParsedExpressionPattern>parsedPattern).requiresSiblings)) {
		if (n === 1) {
			return <ParsedStringPattern>parsedPatterns[0];
		}

		const resultExpression: ParsedStringPattern = function (path: string, basename: string, siblingsFn?: () => string[]) {
			for (let i = 0, n = parsedPatterns.length; i < n; i++) {
				// Pattern matches path
				const result = (<ParsedStringPattern>parsedPatterns[i])(path, basename);
				if (result) {
					return result;
				}
			}

			return null;
		};

		const withBasenames = arrays.first(parsedPatterns, pattern => !!(<ParsedStringPattern>pattern).allBasenames);
		if (withBasenames) {
			resultExpression.allBasenames = (<ParsedStringPattern>withBasenames).allBasenames;
		}

		const allPaths = parsedPatterns.reduce((all, current) => current.allPaths ? all.concat(current.allPaths) : all, <string[]>[]);
		if (allPaths.length) {
			resultExpression.allPaths = allPaths;
		}

		return resultExpression;
	}

	const resultExpression: ParsedStringPattern = function (path: string, basename: string, siblingsFn?: () => string[] | Promise<string[]>) {
		let siblingsPattern: SiblingsPattern | Promise<SiblingsPattern>;
		let siblingsResolved = !siblingsFn;

		function siblingsToSiblingsPattern(siblings: string[]) {
			if (siblings && siblings.length) {
				if (!basename) {
					basename = paths.basename(path);
				}
				const name = basename.substr(0, basename.length - paths.extname(path).length);
				return { siblings, name };
			}

			return undefined;
		}

		function siblingsPatternFn() {
			// Resolve siblings only once
			if (!siblingsResolved) {
				siblingsResolved = true;
				const siblings = siblingsFn();
				siblingsPattern = siblings instanceof Promise ?
					siblings.then(siblingsToSiblingsPattern) :
					siblingsToSiblingsPattern(siblings);
			}

			return siblingsPattern;
		}

		for (let i = 0, n = parsedPatterns.length; i < n; i++) {
			// Pattern matches path
			const result = (<ParsedExpressionPattern>parsedPatterns[i])(path, basename, siblingsPatternFn);
			if (result) {
				return result;
			}
		}

		return null;
	};

	const withBasenames = arrays.first(parsedPatterns, pattern => !!(<ParsedStringPattern>pattern).allBasenames);
	if (withBasenames) {
		resultExpression.allBasenames = (<ParsedStringPattern>withBasenames).allBasenames;
	}

	const allPaths = parsedPatterns.reduce((all, current) => current.allPaths ? all.concat(current.allPaths) : all, <string[]>[]);
	if (allPaths.length) {
		resultExpression.allPaths = allPaths;
	}

	return resultExpression;
}


function parseExpressionPattern(pattern: string, value: any, options: IGlobOptions): (ParsedStringPattern | ParsedExpressionPattern) {
	if (value === false) {
		return NULL; // pattern is disabled
	}

	const parsedPattern = parsePattern(pattern, options);
	if (parsedPattern === NULL) {
		return NULL;
	}

	// Expression Pattern is <boolean>
	if (typeof value === 'boolean') {
		return parsedPattern;
	}

	// Expression Pattern is <SiblingClause>
	if (value) {
		const when = (<SiblingClause>value).when;
		if (typeof when === 'string') {
			const siblingsPatternToMatchingPattern = (siblingsPattern: SiblingsPattern): string => {
				const clausePattern = when.replace('$(basename)', siblingsPattern.name);
				if (siblingsPattern.siblings.indexOf(clausePattern) !== -1) {
					return pattern;
				} else {
					return null; // pattern does not match in the end because the when clause is not satisfied
				}
			};

			const result: ParsedExpressionPattern = (path: string, basename: string, siblingsPatternFn: () => SiblingsPattern | Promise<SiblingsPattern>) => {
				if (!parsedPattern(path, basename)) {
					return null;
				}

				const siblingsPattern = siblingsPatternFn();
				if (!siblingsPattern) {
					return null; // pattern is malformed or we don't have siblings
				}
			
				return siblingsPattern instanceof Promise?
					(<any>siblingsPattern).then(siblingsPatternToMatchingPattern) :
					siblingsPatternToMatchingPattern(<any>siblingsPattern);
			};
			result.requiresSiblings = true;
			return result;
		}
	}

	// Expression is Anything
	return parsedPattern;
}



export function isRelativePattern(obj: any): obj is IRelativePattern {
	const rp = obj as IRelativePattern;

	return rp && typeof rp.base === 'string' && typeof rp.pattern === 'string' && typeof rp.pathToRelative === 'function';
}


function parsePattern(arg1: string | IRelativePattern, options: IGlobOptions): ParsedStringPattern {
	if (!arg1) {
		return NULL;
	}

	// Handle IRelativePattern
	let pattern: string;
	if (typeof arg1 !== 'string') {
		pattern = arg1.pattern;
	} else {
		pattern = arg1;
	}

	// Whitespace trimming
	pattern = pattern.trim();

	// Check cache
	const patternKey = `${pattern}_${!!options.trimForExclusions}`;
	let parsedPattern = CACHE.get(patternKey);
	if (parsedPattern) {
		return wrapRelativePattern(parsedPattern, arg1);
	}

	// Check for Trivias
	let match: RegExpExecArray;
	if (T1.test(pattern)) { // common pattern: **/*.txt just need endsWith check
		const base = pattern.substr(4); // '**/*'.length === 4
		parsedPattern = function (path, basename) {
			return path && strings.endsWith(path, base) ? pattern : null;
		};
	} else if (match = T2.exec(trimForExclusions(pattern, options))) { // common pattern: **/some.txt just need basename check
		parsedPattern = trivia2(match[1], pattern);
	} else if ((options.trimForExclusions ? T3_2 : T3).test(pattern)) { // repetition of common patterns (see above) {**/*.txt,**/*.png}
		parsedPattern = trivia3(pattern, options);
	} else if (match = T4.exec(trimForExclusions(pattern, options))) { // common pattern: **/something/else just need endsWith check
		parsedPattern = trivia4and5(match[1].substr(1), pattern, true);
	} else if (match = T5.exec(trimForExclusions(pattern, options))) { // common pattern: something/else just need equals check
		parsedPattern = trivia4and5(match[1], pattern, false);
	}

	// Otherwise convert to pattern
	else {
		parsedPattern = toRegExp(pattern);
	}

	// Cache
	CACHE.set(patternKey, parsedPattern);

	return wrapRelativePattern(parsedPattern, arg1);
}

function wrapRelativePattern(parsedPattern: ParsedStringPattern, arg2: string | IRelativePattern): ParsedStringPattern {
	if (typeof arg2 === 'string') {
		return parsedPattern;
	}

	return function (path, basename) {
		if (!paths.isEqualOrParent(paths.normalize(path), paths.normalize(arg2.base))) {
			return null;
		}

		return parsedPattern(paths.normalize(arg2.pathToRelative(arg2.base, path)), basename);
	};
}

function trimForExclusions(pattern: string, options: IGlobOptions): string {
	return options.trimForExclusions && strings.endsWith(pattern, '/**') ? pattern.substr(0, pattern.length - 2) : pattern; // dropping **, tailing / is dropped later
}

function trivia2(base: string, originalPattern: string): ParsedStringPattern {
	const slashBase = `/${base}`;
	const backslashBase = `\\${base}`;
	const parsedPattern: ParsedStringPattern = function (path, basename) {
		if (!path) {
			return null;
		}
		if (basename) {
			return basename === base ? originalPattern : null;
		}
		return path === base || strings.endsWith(path, slashBase) || strings.endsWith(path, backslashBase) ? originalPattern : null;
	};
	const basenames = [base];
	parsedPattern.basenames = basenames;
	parsedPattern.patterns = [originalPattern];
	parsedPattern.allBasenames = basenames;
	return parsedPattern;
}

function trivia3(pattern: string, options: IGlobOptions): ParsedStringPattern {
	const parsedPatterns = aggregateBasenameMatches(pattern.slice(1, -1).split(',')
		.map(pattern => parsePattern(pattern, options))
		.filter(pattern => pattern !== NULL), pattern);
	const n = parsedPatterns.length;
	if (!n) {
		return NULL;
	}
	if (n === 1) {
		return <ParsedStringPattern>parsedPatterns[0];
	}
	const parsedPattern: ParsedStringPattern = function (path: string, basename: string) {
		for (let i = 0, n = parsedPatterns.length; i < n; i++) {
			if ((<ParsedStringPattern>parsedPatterns[i])(path, basename)) {
				return pattern;
			}
		}
		return null;
	};
	const withBasenames = arrays.first(parsedPatterns, pattern => !!(<ParsedStringPattern>pattern).allBasenames);
	if (withBasenames) {
		parsedPattern.allBasenames = (<ParsedStringPattern>withBasenames).allBasenames;
	}
	const allPaths = parsedPatterns.reduce((all, current) => current.allPaths ? all.concat(current.allPaths) : all, <string[]>[]);
	if (allPaths.length) {
		parsedPattern.allPaths = allPaths;
	}
	return parsedPattern;
}

function trivia4and5(path: string, pattern: string, matchPathEnds: boolean): ParsedStringPattern {
	const nativePath = paths.nativeSep !== paths.sep ? path.replace(ALL_FORWARD_SLASHES, paths.nativeSep) : path;
	const nativePathEnd = paths.nativeSep + nativePath;
	const parsedPattern: ParsedStringPattern = matchPathEnds ? function (path, basename) {
		return path && (path === nativePath || strings.endsWith(path, nativePathEnd)) ? pattern : null;
	} : function (path, basename) {
		return path && path === nativePath ? pattern : null;
	};
	parsedPattern.allPaths = [(matchPathEnds ? '*/' : './') + path];
	return parsedPattern;
}

function toRegExp(pattern: string): ParsedStringPattern {
	try {
		const regExp = new RegExp(`^${parseRegExp(pattern)}$`);
		return function (path: string, basename: string) {
			regExp.lastIndex = 0; // reset RegExp to its initial state to reuse it!
			return path && regExp.test(path) ? pattern : null;
		};
	} catch (error) {
		return NULL;
	}
}



function parseRegExp(pattern: string): string {
	if (!pattern) {
		return '';
	}

	let regEx = '';

	// Split up into segments for each slash found
	const segments = splitGlobAware(pattern, GLOB_SPLIT);

	// Special case where we only have globstars
	if (segments.every(s => s === GLOBSTAR)) {
		regEx = '.*';
	}

	// Build regex over segments
	else {
		let previousSegmentWasGlobStar = false;
		segments.forEach((segment, index) => {

			// Globstar is special
			if (segment === GLOBSTAR) {

				// if we have more than one globstar after another, just ignore it
				if (!previousSegmentWasGlobStar) {
					regEx += starsToRegExp(2);
					previousSegmentWasGlobStar = true;
				}

				return;
			}

			// States
			let inBraces = false;
			let braceVal = '';

			let inBrackets = false;
			let bracketVal = '';

			let char: string;
			for (let i = 0; i < segment.length; i++) {
				char = segment[i];

				// Support brace expansion
				if (char !== '}' && inBraces) {
					braceVal += char;
					continue;
				}

				// Support brackets
				if (inBrackets && (char !== ']' || !bracketVal) /* ] is literally only allowed as first character in brackets to match it */) {
					let res: string;

					// range operator
					if (char === '-') {
						res = char;
					}

					// negation operator (only valid on first index in bracket)
					else if ((char === '^' || char === '!') && !bracketVal) {
						res = '^';
					}

					// glob split matching is not allowed within character ranges
					// see http://man7.org/linux/man-pages/man7/glob.7.html
					else if (char === GLOB_SPLIT) {
						res = '';
					}

					// anything else gets escaped
					else {
						res = strings.escapeRegExpCharacters(char);
					}

					bracketVal += res;
					continue;
				}

				switch (char) {
					case '{':
						inBraces = true;
						continue;

					case '[':
						inBrackets = true;
						continue;

					case '}':
						const choices = splitGlobAware(braceVal, ',');

						// Converts {foo,bar} => [foo|bar]
						const braceRegExp = `(?:${choices.map(c => parseRegExp(c)).join('|')})`;

						regEx += braceRegExp;

						inBraces = false;
						braceVal = '';

						break;

					case ']':
						regEx += ('[' + bracketVal + ']');

						inBrackets = false;
						bracketVal = '';

						break;


					case '?':
						regEx += NO_PATH_REGEX; // 1 ? matches any single character except path separator (/ and \)
						continue;

					case '*':
						regEx += starsToRegExp(1);
						continue;

					default:
						regEx += strings.escapeRegExpCharacters(char);
				}
			}

			// Tail: Add the slash we had split on if there is more to come and the remaining pattern is not a globstar
			// For example if pattern: some/**/*.js we want the "/" after some to be included in the RegEx to prevent
			// a folder called "something" to match as well.
			// However, if pattern: some/**, we tolerate that we also match on "something" because our globstar behaviour
			// is to match 0-N segments.
			if (index < segments.length - 1 && (segments[index + 1] !== GLOBSTAR || index + 2 < segments.length)) {
				regEx += PATH_REGEX;
			}

			// reset state
			previousSegmentWasGlobStar = false;
		});
	}

	return regEx;
}

function aggregateBasenameMatches(parsedPatterns: (ParsedStringPattern | ParsedExpressionPattern)[], result?: string): (ParsedStringPattern | ParsedExpressionPattern)[] {
	const basenamePatterns = parsedPatterns.filter(parsedPattern => !!(<ParsedStringPattern>parsedPattern).basenames);
	if (basenamePatterns.length < 2) {
		return parsedPatterns;
	}

	const basenames = basenamePatterns.reduce<string[]>((all, current) => all.concat((<ParsedStringPattern>current).basenames), []);
	let patterns: string[];
	if (result) {
		patterns = [];
		for (let i = 0, n = basenames.length; i < n; i++) {
			patterns.push(result);
		}
	} else {
		patterns = basenamePatterns.reduce((all, current) => all.concat((<ParsedStringPattern>current).patterns), []);
	}
	const aggregate: ParsedStringPattern = function (path, basename) {
		if (!path) {
			return null;
		}
		if (!basename) {
			let i: number;
			for (i = path.length; i > 0; i--) {
				const ch = path.charCodeAt(i - 1);
				if (ch === CharCode.Slash || ch === CharCode.Backslash) {
					break;
				}
			}
			basename = path.substr(i);
		}
		const index = basenames.indexOf(basename);
		return index !== -1 ? patterns[index] : null;
	};
	aggregate.basenames = basenames;
	aggregate.patterns = patterns;
	aggregate.allBasenames = basenames;

	const aggregatedPatterns = parsedPatterns.filter(parsedPattern => !(<ParsedStringPattern>parsedPattern).basenames);
	aggregatedPatterns.push(aggregate);
	return aggregatedPatterns;
}

export function splitGlobAware(pattern: string, splitChar: string): string[] {
	if (!pattern) {
		return [];
	}

	const segments: string[] = [];

	let inBraces = false;
	let inBrackets = false;

	let char: string;
	let curVal = '';
	for (let i = 0; i < pattern.length; i++) {
		char = pattern[i];

		switch (char) {
			case splitChar:
				if (!inBraces && !inBrackets) {
					segments.push(curVal);
					curVal = '';

					continue;
				}
				break;
			case '{':
				inBraces = true;
				break;
			case '}':
				inBraces = false;
				break;
			case '[':
				inBrackets = true;
				break;
			case ']':
				inBrackets = false;
				break;
		}

		curVal += char;
	}

	// Tail
	if (curVal) {
		segments.push(curVal);
	}

	return segments;
}

function starsToRegExp(starCount: number): string {
	switch (starCount) {
		case 0:
			return '';
		case 1:
			return `${NO_PATH_REGEX}*?`; // 1 star matches any number of characters except path separator (/ and \) - non greedy (?)
		default:
			// Matches:  (Path Sep OR Path Val followed by Path Sep OR Path Sep followed by Path Val) 0-many times
			// Group is non capturing because we don't need to capture at all (?:...)
			// Overall we use non-greedy matching because it could be that we match too much
			return `(?:${PATH_REGEX}|${NO_PATH_REGEX}+${PATH_REGEX}|${PATH_REGEX}${NO_PATH_REGEX}+)*?`;
	}
}