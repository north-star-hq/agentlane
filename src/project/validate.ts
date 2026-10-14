export interface SchemaProblem {
  path: string;
  schemaPath: string;
  message: string;
}

type Schema = boolean | Readonly<Record<string, unknown>>;

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'title',
  'description',
  'markdownDescription',
  'default',
  'examples',
  'deprecated',
]);

const KEYWORDS = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'oneOf',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(segment: string | number): string {
  return `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sub(schema: Readonly<Record<string, unknown>>, key: string): Schema {
  const value = schema[key];
  if (typeof value === 'boolean' || isRecord(value)) return value;
  throw new Error(`schema keyword ${key} is not a schema`);
}

function list(schema: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = schema[key];
  if (!Array.isArray(value)) throw new Error(`schema keyword ${key} is not a list`);
  return value;
}

function num(schema: Readonly<Record<string, unknown>>, key: string): number {
  const value = schema[key];
  if (typeof value !== 'number') throw new Error(`schema keyword ${key} is not a number`);
  return value;
}

export class SchemaValidator {
  private readonly root: Readonly<Record<string, unknown>>;

  constructor(root: Readonly<Record<string, unknown>>) {
    this.root = root;
  }

  validate(value: unknown): SchemaProblem[] {
    return this.check(value, this.root, '', '#');
  }

  private resolve(ref: string): Schema {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
    const defs = this.root.$defs;
    const target = match?.[1] !== undefined && isRecord(defs) ? defs[match[1]] : undefined;
    if (typeof target === 'boolean' || isRecord(target)) return target;
    throw new Error(`schema $ref ${ref} does not resolve to a schema under #/$defs`);
  }

  private check(value: unknown, schema: Schema, path: string, at: string): SchemaProblem[] {
    if (schema === true) return [];
    if (schema === false) return [{ path, schemaPath: at, message: 'is not allowed here' }];
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`schema keyword '${key}' at ${at} is not supported`);
    }
    const problems: SchemaProblem[] = [];
    const fail = (keyword: string, message: string, where = path) => {
      problems.push({ path: where, schemaPath: `${at}/${keyword}`, message });
    };

    if (typeof schema.$ref === 'string') {
      problems.push(...this.check(value, this.resolve(schema.$ref), path, schema.$ref));
    }
    if (schema.type !== undefined) {
      const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
      if (!types.some(type => hasType(value, type))) {
        fail('type', `must be ${types.map(article).join(' or ')}, not ${article(typeOf(value))}`);
        return problems;
      }
    }
    if (schema.const !== undefined && !equal(value, schema.const)) fail('const', `must be ${show(schema.const)}`);
    if (schema.enum !== undefined && !list(schema, 'enum').some(option => equal(option, value))) {
      fail('enum', `must be one of ${list(schema, 'enum').map(show).join(', ')}, not ${show(value)}`);
    }
    if (schema.oneOf !== undefined) problems.push(...this.oneOf(value, list(schema, 'oneOf') as Schema[], path, `${at}/oneOf`));

    if (isRecord(value)) problems.push(...this.object(value, schema, path, at));
    if (Array.isArray(value)) problems.push(...this.array(value, schema, path, at));
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < num(schema, 'minLength')) {
        fail(
          'minLength',
          value.length === 0 ? 'must not be empty' : `must be at least ${String(num(schema, 'minLength'))} characters`,
        );
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
        fail('pattern', `${show(value)} must match ${schema.pattern}`);
      }
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < num(schema, 'minimum'))
        fail('minimum', `must be at least ${String(num(schema, 'minimum'))}`);
      if (schema.maximum !== undefined && value > num(schema, 'maximum'))
        fail('maximum', `must be at most ${String(num(schema, 'maximum'))}`);
      if (schema.exclusiveMinimum !== undefined && value <= num(schema, 'exclusiveMinimum'))
        fail('exclusiveMinimum', `must be more than ${String(num(schema, 'exclusiveMinimum'))}`);
    }
    return problems;
  }

  private object(
    value: Record<string, unknown>,
    schema: Readonly<Record<string, unknown>>,
    path: string,
    at: string,
  ): SchemaProblem[] {
    const problems: SchemaProblem[] = [];
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.required !== undefined) {
      for (const name of list(schema, 'required') as string[]) {
        if (!(name in value)) problems.push({ path: path + pointer(name), schemaPath: `${at}/required`, message: 'is required' });
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const where = path + pointer(name);
      if (schema.propertyNames !== undefined) {
        problems.push(...this.check(name, sub(schema, 'propertyNames'), where, `${at}/propertyNames`));
      }
      const declared = properties[name];
      if (typeof declared === 'boolean' || isRecord(declared)) {
        problems.push(...this.check(child, declared, where, `${at}/properties${pointer(name)}`));
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties);
        problems.push({
          path: where,
          schemaPath: `${at}/additionalProperties`,
          message: `is not a known field${known.length > 0 ? ` (known: ${known.join(', ')})` : ''}`,
        });
      } else if (schema.additionalProperties !== undefined) {
        problems.push(...this.check(child, sub(schema, 'additionalProperties'), where, `${at}/additionalProperties`));
      }
    }
    return problems;
  }

  private array(value: unknown[], schema: Readonly<Record<string, unknown>>, path: string, at: string): SchemaProblem[] {
    const problems: SchemaProblem[] = [];
    if (schema.minItems !== undefined && value.length < num(schema, 'minItems')) {
      problems.push({
        path,
        schemaPath: `${at}/minItems`,
        message: `must have at least ${String(num(schema, 'minItems'))} item(s)`,
      });
    }
    if (schema.maxItems !== undefined && value.length > num(schema, 'maxItems')) {
      problems.push({
        path,
        schemaPath: `${at}/maxItems`,
        message: `must have at most ${String(num(schema, 'maxItems'))} item(s)`,
      });
    }
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      problems.push({ path, schemaPath: `${at}/uniqueItems`, message: 'must not list an item twice' });
    }
    const prefix = schema.prefixItems === undefined ? [] : (list(schema, 'prefixItems') as Schema[]);
    value.forEach((item, i) => {
      const where = path + pointer(i);
      const positional = prefix[i];
      if (positional !== undefined) problems.push(...this.check(item, positional, where, `${at}/prefixItems/${String(i)}`));
      else if (schema.items !== undefined) problems.push(...this.check(item, sub(schema, 'items'), where, `${at}/items`));
    });
    return problems;
  }

  private oneOf(value: unknown, branches: readonly Schema[], path: string, at: string): SchemaProblem[] {
    const results = branches.map((branch, i) => this.check(value, branch, path, `${at}/${String(i)}`));
    const passing = results.filter(r => r.length === 0).length;
    if (passing === 1) return [];
    if (passing > 1) return [{ path, schemaPath: at, message: 'matches more than one of the allowed shapes' }];
    const isChild = (p: SchemaProblem) => p.path.startsWith(`${path}/`) && !p.path.slice(path.length + 1).includes('/');
    const discriminated = results.filter(r => !r.some(p => p.schemaPath.endsWith('/const') && isChild(p)));
    const [only] = discriminated;
    if (discriminated.length === 1 && only) return only;
    return [{ path, schemaPath: at, message: `must match one of the ${String(branches.length)} allowed shapes` }];
  }
}
