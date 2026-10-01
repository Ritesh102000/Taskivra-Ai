import { ModelAdapterError, type FunctionTool } from './types';
const names = /^[A-Za-z0-9_-]{1,64}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const keys = new Set(['type', 'description', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'anyOf']);
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export function validToolName(name: unknown): name is string { return typeof name === 'string' && names.test(name); }
function schemaFail(): never { throw new ModelAdapterError('model_schema_invalid'); }
export function validateToolDefinitions(tools: FunctionTool[]): void {
  if (!Array.isArray(tools) || tools.length > 32) schemaFail();
  const seen = new Set<string>(); let nodes = 0;
  function validate(schema: unknown, depth: number): void {
    if (!object(schema) || depth > 12 || ++nodes > 2048 || Object.keys(schema).some(key => !keys.has(key))) schemaFail();
    if (schema.description !== undefined && (typeof schema.description !== 'string' || Buffer.byteLength(schema.description) > 2048)) schemaFail();
    if (schema.anyOf !== undefined) {
      if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2 || schema.anyOf.length > 8 || Object.keys(schema).some(key => !['description', 'anyOf'].includes(key))) schemaFail();
      schema.anyOf.forEach(child => validate(child, depth + 1)); return;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.length > 2 || new Set(types).size !== types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type as string)) || (types.length === 2 && !types.includes('null'))) schemaFail();
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256 || schema.enum.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) schemaFail();
    if (schema.const !== undefined && schema.const !== null && !['string', 'number', 'boolean'].includes(typeof schema.const)) schemaFail();
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0 || (schema[key] as number) > 32768)) schemaFail();
    for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) schemaFail();
    if (types.includes('object')) {
      if (schema.additionalProperties !== false || !object(schema.properties) || !Array.isArray(schema.required)) schemaFail();
      const names = Object.keys(schema.properties);
      if (names.length > 64 || names.some(name => forbidden.has(name) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) || schema.required.length !== names.length || new Set(schema.required).size !== names.length || schema.required.some(name => typeof name !== 'string' || !names.includes(name))) schemaFail();
      Object.values(schema.properties).forEach(child => validate(child, depth + 1));
    } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) schemaFail();
    if (types.includes('array')) { if (!schema.items) schemaFail(); validate(schema.items, depth + 1); }
    else if (schema.items !== undefined) schemaFail();
  }
  for (const tool of tools) {
    if (!object(tool) || Object.keys(tool).some(key => !['name', 'description', 'parameters'].includes(key)) || !validToolName(tool.name) || seen.has(tool.name) || typeof tool.description !== 'string' || Buffer.byteLength(tool.description) > 2048 || tool.parameters?.type !== 'object') schemaFail();
    seen.add(tool.name); validate(tool.parameters, 0);
  }
}
export function argumentsMatch(value: unknown, schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(child => argumentsMatch(value, child as Record<string, unknown>, depth + 1));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && Number.isSafeInteger(value) && types.includes('integer'))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value)) return false;
  if ('const' in schema && schema.const !== value) return false;
  if (actual === 'null') return true;
  if (actual === 'string') { const length = [...value as string].length; if (length > 32768 || (typeof schema.minLength === 'number' && length < schema.minLength) || (typeof schema.maxLength === 'number' && length > schema.maxLength)) return false; }
  if (actual === 'number') { if (!Number.isFinite(value) || (typeof schema.minimum === 'number' && (value as number) < schema.minimum) || (typeof schema.maximum === 'number' && (value as number) > schema.maximum)) return false; }
  if (actual === 'array') {
    const values = value as unknown[];
    if (values.length > 256 || (typeof schema.minItems === 'number' && values.length < schema.minItems) || (typeof schema.maxItems === 'number' && values.length > schema.maxItems)) return false;
    return values.every(item => argumentsMatch(item, schema.items as Record<string, unknown>, depth + 1));
  }
  if (actual === 'object') {
    if (!object(value) || !object(schema.properties)) return false;
    const properties = schema.properties, required = schema.required as string[];
    if (Object.keys(value).some(key => forbidden.has(key) || !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => argumentsMatch(item, properties[key] as Record<string, unknown>, depth + 1));
  }
  return true;
}
