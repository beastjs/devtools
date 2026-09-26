import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type * as TS from 'typescript'
import type { TypeImport } from '../shared/types.js'

/** One set of bindings whose types should be read at a probe call site. */
export interface TypeProbe {
  id: string
  names: string[]
}

/**
 * A virtual TypeScript module standing in for a `.btsx` file. It holds the
 * file's imports and module code, followed by one function per probe that
 * replays the host component's props, setup, and enclosing control flow
 * before calling `__beastUse(...names)`.
 */
export interface ProbeFile {
  /** Absolute path of the `.btsx` source; relative imports resolve from here. */
  sourcePath: string
  code: string
  probes: TypeProbe[]
}

export interface ResolvedType {
  type: string
  /** Type-only imports the type text needs in the source file's directory. */
  imports: TypeImport[]
}

export type ProbeResult = Map<string, Map<string, ResolvedType>>

/** Imports and module code of another `.btsx` file, enough to type its exports. */
export interface BtsxModule {
  imports: string[]
  moduleCode: string[]
}

export const PROBE_CALL = '__beastUse'

const PROBE_SUFFIX = '.__beast_probe__.ts'
const MODULE_SUFFIX = '.__beast_module__.ts'
const MAX_DEPTH = 8

/**
 * Derives prop types with the project's own TypeScript. It is optional: when
 * TypeScript cannot be loaded, `resolve` returns null and the analyzer keeps
 * its heuristic types.
 */
export class TypeResolver {
  readonly #root: string
  readonly #loadBtsx: (absolutePath: string) => BtsxModule | null
  readonly #files = new Map<string, { version: number; text: string }>()
  #ts: typeof TS | null | undefined
  #service: TS.LanguageService | null = null

  constructor(root: string, loadBtsx: (absolutePath: string) => BtsxModule | null) {
    this.#root = root
    this.#loadBtsx = loadBtsx
  }

  get available(): boolean {
    return this.#typescript() !== null
  }

  resolve(file: ProbeFile): ProbeResult | null {
    const ts = this.#typescript()
    if (ts === null || file.probes.length === 0) return null
    try {
      const probePath = file.sourcePath + PROBE_SUFFIX
      this.#write(probePath, file.code)
      const program = this.#languageService(ts).getProgram()
      const sourceFile = program?.getSourceFile(probePath)
      if (program === undefined || sourceFile === undefined) return null
      return new Printer(ts, program, sourceFile, dirname(file.sourcePath)).read(file.probes)
    } catch {
      return null
    }
  }

  #typescript(): typeof TS | null {
    if (this.#ts !== undefined) return this.#ts
    // Prefer the app's TypeScript so types match what its editor reports.
    for (const base of [join(this.#root, 'package.json'), import.meta.url]) {
      try {
        this.#ts = createRequire(base)('typescript') as typeof TS
        return this.#ts
      } catch {
        // Try the next location.
      }
    }
    this.#ts = null
    return null
  }

  #write(path: string, text: string): void {
    const current = this.#files.get(path)
    if (current?.text !== text) this.#files.set(path, { version: (current?.version ?? 0) + 1, text })
  }

  /** Virtual `.btsx` modules are regenerated whenever their source changes. */
  #moduleText(path: string): string | undefined {
    if (!path.endsWith(MODULE_SUFFIX)) return this.#files.get(path)?.text
    const module = this.#loadBtsx(path.slice(0, -MODULE_SUFFIX.length))
    if (module === null) return undefined
    const text = [
      ...module.imports,
      ...module.moduleCode,
      'declare const __beastDefault: any',
      'export default __beastDefault',
    ].join('\n')
    this.#write(path, text)
    return text
  }

  #languageService(ts: typeof TS): TS.LanguageService {
    if (this.#service !== null) return this.#service
    const options = this.#compilerOptions(ts)
    const exists = (path: string) => this.#files.has(path) || (path.endsWith(MODULE_SUFFIX) && existsSync(path.slice(0, -MODULE_SUFFIX.length))) || ts.sys.fileExists(path)
    const read = (path: string) => this.#moduleText(path) ?? ts.sys.readFile(path)
    const cache = ts.createModuleResolutionCache(this.#root, (name) => name, options)
    const resolutionHost: TS.ModuleResolutionHost = {
      fileExists: exists,
      readFile: read,
      directoryExists: ts.sys.directoryExists,
      realpath: ts.sys.realpath,
      getCurrentDirectory: () => this.#root,
    }

    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...this.#files.keys()].filter((path) => path.endsWith(PROBE_SUFFIX)),
      getScriptVersion: (path) => String(this.#files.get(path)?.version ?? 0),
      getScriptSnapshot: (path) => {
        const text = read(path)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => this.#root,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      fileExists: exists,
      readFile: read,
      directoryExists: ts.sys.directoryExists,
      realpath: ts.sys.realpath,
      resolveModuleNameLiterals: (literals, containingFile, _redirect, compilerOptions) =>
        literals.map((literal) => {
          const specifier = literal.text
          if (specifier.endsWith('.btsx')) {
            if (!specifier.startsWith('.')) return { resolvedModule: undefined }
            const target = resolve(dirname(containingFile), specifier)
            if (!existsSync(target)) return { resolvedModule: undefined }
            return {
              resolvedModule: { resolvedFileName: target + MODULE_SUFFIX, extension: ts.Extension.Ts, isExternalLibraryImport: false },
            }
          }
          return ts.resolveModuleName(specifier, containingFile, compilerOptions, resolutionHost, cache)
        }),
    }
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry())
    return this.#service
  }

  #compilerOptions(ts: typeof TS): TS.CompilerOptions {
    let options: TS.CompilerOptions = {}
    const configPath = ts.findConfigFile(this.#root, ts.sys.fileExists, 'tsconfig.json')
    if (configPath !== undefined && dirname(configPath) === this.#root) {
      const { config } = ts.readConfigFile(configPath, ts.sys.readFile)
      options = ts.parseJsonConfigFileContent(config ?? {}, ts.sys, this.#root).options
    }
    return {
      ...options,
      target: options.target ?? ts.ScriptTarget.ES2022,
      module: options.module ?? ts.ModuleKind.ESNext,
      moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
      strict: options.strict ?? true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      allowJs: false,
      // Ambient `types` packages (node, vite/client) are not needed to type
      // component code and make the first check much slower.
      types: [],
      plugins: [],
      composite: false,
      incremental: false,
    }
  }
}

/** Writes checker types back as source text that is valid in the `.btsx` file. */
class Printer {
  readonly #ts: typeof TS
  readonly #program: TS.Program
  readonly #checker: TS.TypeChecker
  readonly #sourceFile: TS.SourceFile
  readonly #sourceDir: string
  /** Import bindings of the probe file: target symbol → local name. */
  readonly #imported = new Map<TS.Symbol, string>()
  readonly #localNames = new Set<string>()
  #imports: TypeImport[] = []
  #node: TS.Node
  readonly #format: TS.TypeFormatFlags

  constructor(ts: typeof TS, program: TS.Program, sourceFile: TS.SourceFile, sourceDir: string) {
    this.#ts = ts
    this.#program = program
    this.#checker = program.getTypeChecker()
    this.#sourceFile = sourceFile
    this.#sourceDir = sourceDir
    this.#node = sourceFile
    // Match the file's quote style in string literal types.
    const text = sourceFile.text
    const single = (text.match(/'/g) ?? []).length > (text.match(/"/g) ?? []).length
    this.#format = ts.TypeFormatFlags.NoTruncation | (single ? ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType : 0)

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        const names = [
          clause?.name,
          ...(clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.map((element) => element.name)
            : []),
        ]
        for (const name of names) {
          if (name === undefined) continue
          this.#localNames.add(name.text)
          const local = this.#checker.getSymbolAtLocation(name)
          if (local !== undefined) this.#imported.set(this.#target(local), name.text)
        }
      } else {
        for (const name of declaredNames(ts, statement)) this.#localNames.add(name)
      }
    }
  }

  read(probes: readonly TypeProbe[]): ProbeResult {
    const ts = this.#ts
    const calls = new Map<string, TS.CallExpression>()
    const visit = (node: TS.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const id = node.name.text
        const find = (child: TS.Node): void => {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === PROBE_CALL) {
            calls.set(id, child)
            return
          }
          ts.forEachChild(child, find)
        }
        find(node)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(this.#sourceFile)

    const result: ProbeResult = new Map()
    for (const probe of probes) {
      const call = calls.get(probe.id)
      if (call === undefined) continue
      const types = new Map<string, ResolvedType>()
      probe.names.forEach((name, index) => {
        const argument = call.arguments[index]
        if (argument === undefined) return
        this.#imports = []
        this.#node = argument
        const type = this.#print(this.#checker.getTypeAtLocation(argument), 0)
        types.set(name, { type, imports: this.#imports })
      })
      result.set(probe.id, types)
    }
    return result
  }

  #print(type: TS.Type, depth: number): string {
    const ts = this.#ts
    const checker = this.#checker
    if (depth > MAX_DEPTH) return 'unknown'

    if (type.aliasSymbol !== undefined) {
      const name = this.#reference(type.aliasSymbol)
      if (name !== null) return name + this.#typeArguments(type.aliasTypeArguments, depth)
    }

    const simple =
      ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean |
      ts.TypeFlags.BigInt | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never |
      ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral |
      ts.TypeFlags.ESSymbol | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TemplateLiteral
    if (type.flags & simple) return checker.typeToString(type, undefined, this.#format)

    if (type.flags & ts.TypeFlags.EnumLiteral || type.flags & ts.TypeFlags.Enum) {
      const symbol = type.flags & ts.TypeFlags.EnumLiteral ? parentEnum(type.symbol) : type.symbol
      const name = symbol === undefined ? null : this.#reference(symbol)
      if (name !== null) return type.flags & ts.TypeFlags.EnumLiteral && symbol !== type.symbol ? `${name}.${type.symbol.name}` : name
      return checker.typeToString(checker.getBaseTypeOfLiteralType(type))
    }

    if (type.isUnion()) {
      // `origin` (internal but stable) keeps the union as written, so
      // `PanelSide | null` is not flattened into its literal members.
      const origin = (type as TS.UnionType & { origin?: TS.Type }).origin
      const members = [...(origin?.isUnion() ? origin.types : type.types)]
      const trueType = members.find((member) => member.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(member) === 'true')
      const falseType = members.find((member) => member.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(member) === 'false')
      const parts = members
        .filter((member) => trueType === undefined || falseType === undefined || (member !== trueType && member !== falseType))
        .map((member) => this.#wrap(member, depth + 1))
      if (trueType !== undefined && falseType !== undefined) parts.splice(0, 0, 'boolean')
      const nullish = (part: string) => part === 'null' || part === 'undefined'
      return [...new Set([...parts.filter((part) => !nullish(part)), ...parts.filter(nullish)])].join(' | ')
    }
    if (type.isIntersection()) return type.types.map((member) => this.#wrap(member, depth + 1)).join(' & ')
    if (type.flags & ts.TypeFlags.TypeParameter) return 'unknown'

    if (type.flags & ts.TypeFlags.Object) {
      const object = type as TS.ObjectType
      if (checker.isTupleType(type)) {
        return `[${checker.getTypeArguments(type as TS.TypeReference).map((item) => this.#print(item, depth + 1)).join(', ')}]`
      }
      if (checker.isArrayType(type)) {
        const [element] = checker.getTypeArguments(type as TS.TypeReference)
        const readonly = type.symbol?.name === 'ReadonlyArray' ? 'readonly ' : ''
        return `${readonly}${element === undefined ? 'unknown' : this.#wrap(element, depth + 1)}[]`
      }
      const named = object.objectFlags & (ts.ObjectFlags.Reference | ts.ObjectFlags.Class | ts.ObjectFlags.Interface)
      if (named && type.symbol !== undefined) {
        const name = this.#reference(type.symbol)
        if (name !== null) {
          const args = object.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type as TS.TypeReference) : []
          return name + this.#typeArguments(args, depth)
        }
      }
      return this.#structural(type, depth)
    }
    return checker.typeToString(type, this.#sourceFile, this.#format)
  }

  #structural(type: TS.Type, depth: number): string {
    const ts = this.#ts
    const checker = this.#checker
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
    const properties = checker.getPropertiesOfType(type)
    const indexes = checker.getIndexInfosOfType(type)
    if (calls.length === 1 && properties.length === 0 && indexes.length === 0) return this.#signature(calls[0]!, depth)

    const members = [
      ...calls.map((signature) => this.#signature(signature, depth, ': ')),
      ...indexes.map((info) => `[key: ${this.#print(info.keyType, depth + 1)}]: ${this.#print(info.type, depth + 1)}`),
      ...properties.map((property) => {
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
        const propertyType = checker.getTypeOfSymbolAtLocation(property, this.#node)
        let text = this.#print(propertyType, depth + 1)
        // `?:` already admits undefined.
        if (optional && text.endsWith(' | undefined')) text = text.slice(0, -' | undefined'.length)
        const readonly = property.declarations?.some((declaration) => ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly)
        const key = /^[A-Za-z_$][\w$]*$/.test(property.name) ? property.name : JSON.stringify(property.name)
        return `${readonly ? 'readonly ' : ''}${key}${optional ? '?' : ''}: ${text}`
      }),
    ]
    return members.length === 0 ? '{}' : `{ ${members.join('; ')} }`
  }

  #signature(signature: TS.Signature, depth: number, separator = ' => '): string {
    const ts = this.#ts
    const parameters = signature.parameters.map((parameter, index) => {
      const declaration = parameter.valueDeclaration
      const node = declaration !== undefined && ts.isParameter(declaration) ? declaration : undefined
      const rest = node?.dotDotDotToken !== undefined
      const optional = node?.questionToken !== undefined || node?.initializer !== undefined
      const name = /^[A-Za-z_$][\w$]*$/.test(parameter.name) && !parameter.name.startsWith('__') ? parameter.name : `arg${index}`
      const parameterType = this.#checker.getTypeOfSymbolAtLocation(parameter, this.#node)
      return `${rest ? '...' : ''}${name}${optional && !rest ? '?' : ''}: ${this.#print(parameterType, depth + 1)}`
    })
    const returns = this.#print(this.#checker.getReturnTypeOfSignature(signature), depth + 1)
    return `(${parameters.join(', ')})${separator}${returns}`
  }

  /** Parenthesize function and union members where precedence requires it. */
  #wrap(type: TS.Type, depth: number): string {
    const text = this.#print(type, depth)
    return /=>/.test(text) && !text.startsWith('{') || / [|&] /.test(text) && !/^[[{(]/.test(text) ? `(${text})` : text
  }

  #typeArguments(args: readonly TS.Type[] | undefined, depth: number): string {
    return args === undefined || args.length === 0 ? '' : `<${args.map((arg) => this.#print(arg, depth + 1)).join(', ')}>`
  }

  #target(symbol: TS.Symbol): TS.Symbol {
    return symbol.flags & this.#ts.SymbolFlags.Alias ? this.#checker.getAliasedSymbol(symbol) : symbol
  }

  /**
   * The name that refers to `symbol` from the `.btsx` file, adding a type
   * import when the declaration is exported somewhere reachable. Returns null
   * when no name can reach it, so the caller prints the type structurally.
   */
  #reference(symbol: TS.Symbol): string | null {
    const ts = this.#ts
    const target = this.#target(symbol)
    const declaration = target.declarations?.[0]
    if (declaration === undefined || target.name.startsWith('__')) return null
    const declarationFile = declaration.getSourceFile()

    const imported = this.#imported.get(target)
    if (imported !== undefined) return imported

    if (declarationFile === this.#sourceFile) {
      return declaration.parent === this.#sourceFile ? target.name : null
    }

    // Globals: the default library and ambient script declarations.
    if (this.#program.isSourceFileDefaultLibrary(declarationFile) || !ts.isExternalModule(declarationFile)) {
      return this.#localNames.has(target.name) ? null : target.name
    }

    for (const specifier of this.#specifiers(declarationFile.fileName)) {
      const exportName = this.#exportName(specifier, target)
      if (exportName === null || exportName === 'default') continue
      if (this.#localNames.has(exportName)) return null
      if (!this.#imports.some((entry) => entry.name === exportName && entry.from === specifier)) {
        this.#imports.push({ name: exportName, from: specifier })
      }
      return exportName
    }
    return null
  }

  /** Module specifiers, from the `.btsx` file's directory, that may export a declaration. */
  #specifiers(fileName: string): string[] {
    if (fileName.endsWith(MODULE_SUFFIX)) return [relativeSpecifier(this.#sourceDir, fileName.slice(0, -MODULE_SUFFIX.length))]
    const packageMatch = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(fileName)
    if (packageMatch !== null) return [packageMatch[1]!.split(sep).join('/')]
    return [relativeSpecifier(this.#sourceDir, fileName.replace(/\.d\.ts$/, ''))]
  }

  #exportName(specifier: string, target: TS.Symbol): string | null {
    const ts = this.#ts
    const resolved = ts.resolveModuleName(specifier, this.#sourceFile.fileName, this.#program.getCompilerOptions(), ts.sys)
    const fileName = resolved.resolvedModule?.resolvedFileName ??
      (specifier.endsWith('.btsx') ? resolve(this.#sourceDir, specifier) + MODULE_SUFFIX : undefined)
    const moduleFile = fileName === undefined ? undefined : this.#program.getSourceFile(fileName)
    const moduleSymbol = moduleFile === undefined ? undefined : this.#checker.getSymbolAtLocation(moduleFile)
    if (moduleSymbol === undefined) return null
    const match = this.#checker.getExportsOfModule(moduleSymbol).find((entry) => this.#target(entry) === target)
    return match?.name ?? null
  }
}

function parentEnum(symbol: TS.Symbol | undefined): TS.Symbol | undefined {
  return (symbol as (TS.Symbol & { parent?: TS.Symbol }) | undefined)?.parent
}

function declaredNames(ts: typeof TS, statement: TS.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [declaration.name.text] : []))
  }
  const named = statement as TS.Statement & { name?: TS.Node }
  return named.name !== undefined && ts.isIdentifier(named.name) ? [named.name.text] : []
}

function relativeSpecifier(fromDir: string, file: string): string {
  const path = relative(fromDir, file).split(sep).join('/')
  return path.startsWith('.') ? path : `./${path}`
}
