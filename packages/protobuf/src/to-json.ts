// Copyright 2021-2025 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  type DescEnum,
  type DescEnumValue,
  type DescField,
  type DescMessage,
  ScalarType,
} from "./descriptors.js";
import type { JsonObject, JsonValue } from "./json-value.js";
import { protoCamelCase } from "./reflect/names.js";
import { reflect } from "./reflect/reflect.js";
import type { Registry } from "./registry.js";
import type {
  ReflectList,
  ReflectMap,
  ReflectMessage,
} from "./reflect/reflect-types.js";
import type {
  EnumJsonType,
  EnumShape,
  Message,
  MessageJsonType,
  MessageShape,
} from "./types.js";
import type {
  Any,
  Duration,
  FeatureSet_FieldPresence,
  FieldMask,
  ListValue,
  Struct,
  Timestamp,
  Value,
} from "./wkt/index.js";
import { anyUnpack } from "./wkt/index.js";
import { isWrapperDesc } from "./wkt/wrappers.js";
import { base64Encode } from "./wire/index.js";
import { createExtensionContainer, getExtension } from "./extensions.js";
import { checkField, formatVal } from "./reflect/reflect-check.js";

// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.LEGACY_REQUIRED: const $name: FeatureSet_FieldPresence.$localName = $number;
const LEGACY_REQUIRED: FeatureSet_FieldPresence.LEGACY_REQUIRED = 3;

// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.IMPLICIT: const $name: FeatureSet_FieldPresence.$localName = $number;
const IMPLICIT: FeatureSet_FieldPresence.IMPLICIT = 2;

/**
 * Options for serializing to JSON.
 */
export interface JsonWriteOptions {
  /**
   * By default, fields with implicit presence are not serialized if they are
   * unset. For example, an empty list field or a proto3 int32 field with 0 is
   * not serialized. With this option enabled, such fields are included in the
   * output.
   */
  alwaysEmitImplicit: boolean;

  /**
   * Emit enum values as integers instead of strings: The name of an enum
   * value is used by default in JSON output. An option may be provided to
   * use the numeric value of the enum value instead.
   */
  enumAsInteger: boolean;

  /**
   * Use proto field name instead of lowerCamelCase name: By default proto3
   * JSON printer should convert the field name to lowerCamelCase and use
   * that as the JSON name. An implementation may provide an option to use
   * proto field name as the JSON name instead. Proto3 JSON parsers are
   * required to accept both the converted lowerCamelCase name and the proto
   * field name.
   */
  useProtoFieldName: boolean;

  /**
   * This option is required to write `google.protobuf.Any` and extensions
   * to JSON format.
   */
  registry?: Registry;
}

/**
 * Options for serializing to JSON.
 */
export interface JsonWriteStringOptions extends JsonWriteOptions {
  /**
   * Format JSON with indentation. Indicates the number of space characters to
   * be used as indentation.
   *
   * This option is passed to JSON.stringify as `space`.
   */
  prettySpaces: number;
}

// Default options for serializing to JSON.
const jsonWriteDefaults: Readonly<JsonWriteOptions> = {
  alwaysEmitImplicit: false,
  enumAsInteger: false,
  useProtoFieldName: false,
};

function makeWriteOptions(
  options?: Partial<JsonWriteOptions>,
): Readonly<JsonWriteOptions> {
  return options ? { ...jsonWriteDefaults, ...options } : jsonWriteDefaults;
}

/**
 * Serialize the message to a JSON value, a JavaScript value that can be
 * passed to JSON.stringify().
 */
export function toJson<
  Desc extends DescMessage,
  Opts extends Partial<JsonWriteOptions> | undefined = undefined,
>(
  schema: Desc,
  message: MessageShape<Desc>,
  options?: Opts,
): ToJson<Desc, Opts> {
  return reflectToJson(
    reflect(schema, message),
    makeWriteOptions(options),
  ) as ToJson<Desc, Opts>;
}

// For standard JSON write options, return the JSON type if available.
// Otherwise, return a generic JSON value.
type ToJson<
  Desc extends DescMessage,
  Opts extends undefined | Partial<JsonWriteOptions>,
> = Opts extends
  | undefined
  | {
      alwaysEmitImplicit?: false;
      enumAsInteger?: false;
      useProtoFieldName?: false;
    }
  ? MessageJsonType<Desc>
  : JsonValue;

/**
 * Serialize the message to a JSON string.
 */
export function toJsonString<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  options?: Partial<JsonWriteStringOptions>,
): string {
  const jsonValue = toJson(schema, message, options);
  return JSON.stringify(jsonValue, null, options?.prettySpaces ?? 0);
}

/**
 * Serialize a single enum value to JSON.
 */
export function enumToJson<Desc extends DescEnum>(
  descEnum: Desc,
  value: EnumShape<Desc>,
): EnumJsonType<Desc> {
  if (descEnum.typeName == "google.protobuf.NullValue") {
    return null as EnumJsonType<Desc>;
  }
  const name = (descEnum.value[value] as DescEnumValue | undefined)?.name;
  if (name === undefined) {
    throw new Error(`${value} is not a value in ${descEnum}`);
  }
  return name as EnumJsonType<Desc>;
}

function reflectToJson(
  message: ReflectMessage,
  options: JsonWriteOptions,
): JsonValue {
  const wktJson = tryWktToJson(message, options);
  if (wktJson !== undefined) return wktJson;
  const json: JsonObject = {};
  for (const field of message.sortedFields) {
    if (!message.isSet(field)) {
      if (field.presence == LEGACY_REQUIRED) {
        throw new Error(
          `cannot encode ${field} to JSON: required field not set`,
        );
      }
      if (!options.alwaysEmitImplicit || field.presence !== IMPLICIT) {
        // Fields with implicit presence omit zero values (e.g. empty string) by default
        continue;
      }
    }
    const jsonValue = fieldToJson(field, message.get(field), options);
    if (jsonValue !== undefined) {
      json[jsonName(field, options)] = jsonValue;
    }
  }
  if (options.registry) {
    const processedFieldNumbers = new Set<number>();
    for (const { no } of message.getUnknown() ?? []) {
      // Same tag can appear multiple times, so we
      // keep track and skip identical ones.
      if (!processedFieldNumbers.has(no)) {
        processedFieldNumbers.add(no);
        const extension = options.registry.getExtensionFor(message.desc, no);
        if (!extension) {
          continue;
        }
        const value = getExtension(message.message, extension);
        const [container, field] = createExtensionContainer(extension, value);
        const jsonValue = fieldToJson(field, container.get(field), options);
        if (jsonValue !== undefined) {
          json[extension.jsonName] = jsonValue;
        }
      }
    }
  }
  return json;
}

function fieldToJson(
  field: DescField,
  value: unknown,
  options: JsonWriteOptions,
) {
  switch (field.fieldKind) {
    case "scalar":
      return scalarToJson(field, value);
    case "message":
      return reflectToJson(value as ReflectMessage, options);
    case "enum":
      return enumToJsonInternal(field.enum, value, options.enumAsInteger);
    case "list":
      return listToJson(value as ReflectList, options);
    case "map":
      return mapToJson(value as ReflectMap, options);
  }
}

function mapToJson(map: ReflectMap, options: JsonWriteOptions) {
  const field = map.field();
  const jsonObject: JsonObject = {};
  switch (field.mapKind) {
    case "scalar":
      for (const [entryKey, entryValue] of map) {
        jsonObject[entryKey as keyof object] = scalarToJson(field, entryValue);
      }
      break;
    case "message":
      for (const [entryKey, entryValue] of map) {
        jsonObject[entryKey as keyof object] = reflectToJson(
          entryValue as ReflectMessage,
          options,
        );
      }
      break;
    case "enum":
      for (const [entryKey, entryValue] of map) {
        jsonObject[entryKey as keyof object] = enumToJsonInternal(
          field.enum,
          entryValue,
          options.enumAsInteger,
        );
      }
      break;
  }
  return options.alwaysEmitImplicit || map.size > 0 ? jsonObject : undefined;
}

function listToJson(list: ReflectList, options: JsonWriteOptions) {
  const field = list.field();
  const jsonArray: JsonValue[] = [];
  switch (field.listKind) {
    case "scalar":
      for (const item of list) {
        jsonArray.push(scalarToJson(field, item) as JsonValue);
      }
      break;
    case "enum":
      for (const item of list) {
        jsonArray.push(
          enumToJsonInternal(field.enum, item, options.enumAsInteger) as JsonValue,
        );
      }
      break;
    case "message":
      for (const item of list) {
        jsonArray.push(reflectToJson(item as ReflectMessage, options));
      }
      break;
  }
  return options.alwaysEmitImplicit || jsonArray.length > 0
    ? jsonArray
    : undefined;
}

function enumToJsonInternal(
  enumDescriptor: DescEnum,
  value: unknown,
  enumAsInteger: boolean,
): string | number | null {
  if (typeof value != "number") {
    throw new Error(
      `cannot encode ${enumDescriptor} to JSON: expected number, got ${formatVal(value)}`,
    );
  }
  if (enumDescriptor.typeName == "google.protobuf.NullValue") {
    return null;
  }
  if (enumAsInteger) {
    return value;
  }
  const enumValueDescriptor = enumDescriptor.value[value] as
    | DescEnumValue
    | undefined;
  return enumValueDescriptor?.name ?? value; // if we don't know the enum value, just return the number
}

function scalarToJson(
  field: DescField & { scalar: ScalarType },
  value: unknown,
): string | number | boolean {
  switch (field.scalar) {
    // int32, fixed32, uint32: JSON value will be a decimal number. Either numbers or strings are accepted.
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
      if (typeof value != "number") {
        throw new Error(
          `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
        );
      }
      return value;

    // float, double: JSON value will be a number or one of the special string values "NaN", "Infinity", and "-Infinity".
    // Either numbers or strings are accepted. Exponent notation is also accepted.
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE: // eslint-disable-line no-fallthrough
      if (typeof value != "number") {
        throw new Error(
          `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
        );
      }
      if (Number.isNaN(value)) return "NaN";
      if (value === Number.POSITIVE_INFINITY) return "Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
      return value;

    // string:
    case ScalarType.STRING:
      if (typeof value != "string") {
        throw new Error(
          `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
        );
      }
      return value;

    // bool:
    case ScalarType.BOOL:
      if (typeof value != "boolean") {
        throw new Error(
          `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
        );
      }
      return value;

    // JSON value will be a decimal string. Either numbers or strings are accepted.
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof value != "bigint" && typeof value != "string") {
        throw new Error(
          `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
        );
      }
      return value.toString();

    // bytes: JSON value will be the data encoded as a string using standard base64 encoding with paddings.
    // Either standard or URL-safe base64 encoding with/without paddings are accepted.
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) {
        return base64Encode(value);
      }
      throw new Error(
        `cannot encode ${field} to JSON: ${checkField(field, value)?.message}`,
      );
  }
}

function jsonName(field: DescField, options: JsonWriteOptions) {
  return options.useProtoFieldName ? field.name : field.jsonName;
}

// returns a json value if wkt, otherwise returns undefined.
function tryWktToJson(
  message: ReflectMessage,
  options: JsonWriteOptions,
): JsonValue | undefined {
  if (!message.desc.typeName.startsWith("google.protobuf.")) {
    return undefined;
  }
  switch (message.desc.typeName) {
    case "google.protobuf.Any":
      return anyToJson(message.message as Any, options);
    case "google.protobuf.Timestamp":
      return timestampToJson(message.message as Timestamp);
    case "google.protobuf.Duration":
      return durationToJson(message.message as Duration);
    case "google.protobuf.FieldMask":
      return fieldMaskToJson(message.message as FieldMask);
    case "google.protobuf.Struct":
      return structToJson(message.message as Struct);
    case "google.protobuf.Value":
      return valueToJson(message.message as Value);
    case "google.protobuf.ListValue":
      return listValueToJson(message.message as ListValue);
    default:
      if (isWrapperDesc(message.desc)) {
        const valueField = message.desc.fields[0];
        return scalarToJson(valueField, message.get(valueField));
      }
      return undefined;
  }
}

function anyToJson(anyValue: Any, options: JsonWriteOptions): JsonValue {
  if (anyValue.typeUrl === "") {
    return {};
  }
  const { registry } = options;
  let unpackedMessage: Message | undefined;
  let messageDescriptor: DescMessage | undefined;
  if (registry) {
    unpackedMessage = anyUnpack(anyValue, registry);
    if (unpackedMessage) {
      messageDescriptor = registry.getMessage(unpackedMessage.$typeName);
    }
  }
  if (!messageDescriptor || !unpackedMessage) {
    throw new Error(
      `cannot encode message ${anyValue.$typeName} to JSON: "${anyValue.typeUrl}" is not in the type registry`,
    );
  }
  let json = reflectToJson(reflect(messageDescriptor, unpackedMessage), options);
  if (
    messageDescriptor.typeName.startsWith("google.protobuf.") ||
    json === null ||
    Array.isArray(json) ||
    typeof json !== "object"
  ) {
    json = { value: json };
  }
  json["@type"] = anyValue.typeUrl;
  return json;
}

function durationToJson(duration: Duration) {
  const seconds = Number(duration.seconds);
  const nanos = duration.nanos;
  if (seconds > 315576000000 || seconds < -315576000000) {
    throw new Error(
      `cannot encode message ${duration.$typeName} to JSON: value out of range`,
    );
  }
  if ((seconds > 0 && nanos < 0) || (seconds < 0 && nanos > 0)) {
    throw new Error(
      `cannot encode message ${duration.$typeName} to JSON: nanos sign must match seconds sign`,
    );
  }
  let text = duration.seconds.toString();
  if (nanos !== 0) {
    let nanosStr = Math.abs(nanos).toString();
    nanosStr = "0".repeat(9 - nanosStr.length) + nanosStr;
    if (nanosStr.substring(3) === "000000") {
      nanosStr = nanosStr.substring(0, 3);
    } else if (nanosStr.substring(6) === "000") {
      nanosStr = nanosStr.substring(0, 6);
    }
    text += "." + nanosStr;
    if (nanos < 0 && seconds == 0) {
      text = "-" + text;
    }
  }
  return text + "s";
}

function fieldMaskToJson(fieldMask: FieldMask) {
  return fieldMask.paths
    .map((path) => {
      if (path.match(/_[0-9]?_/g) || path.match(/[A-Z]/g)) {
        throw new Error(
          `cannot encode message ${fieldMask.$typeName} to JSON: lowerCamelCase of path name "` +
            path +
            '" is irreversible',
        );
      }
      return protoCamelCase(path);
    })
    .join(",");
}

function structToJson(struct: Struct) {
  const json: JsonObject = {};
  for (const [key, value] of Object.entries(struct.fields)) {
    json[key] = valueToJson(value);
  }
  return json;
}

function valueToJson(value: Value) {
  switch (value.kind.case) {
    case "nullValue":
      return null;
    case "numberValue":
      if (!Number.isFinite(value.kind.value)) {
        throw new Error(`${value.$typeName} cannot be NaN or Infinity`);
      }
      return value.kind.value;
    case "boolValue":
      return value.kind.value;
    case "stringValue":
      return value.kind.value;
    case "structValue":
      return structToJson(value.kind.value);
    case "listValue":
      return listValueToJson(value.kind.value);
    default:
      throw new Error(`${value.$typeName} must have a value`);
  }
}

function listValueToJson(listValue: ListValue): JsonValue[] {
  return listValue.values.map(valueToJson);
}

function timestampToJson(timestamp: Timestamp) {
  const milliseconds = Number(timestamp.seconds) * 1000;
  if (
    milliseconds < Date.parse("0001-01-01T00:00:00Z") ||
    milliseconds > Date.parse("9999-12-31T23:59:59Z")
  ) {
    throw new Error(
      `cannot encode message ${timestamp.$typeName} to JSON: must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive`,
    );
  }
  if (timestamp.nanos < 0) {
    throw new Error(
      `cannot encode message ${timestamp.$typeName} to JSON: nanos must not be negative`,
    );
  }
  if (timestamp.nanos > 999999999) {
    throw new Error(
      `cannot encode message ${timestamp.$typeName} to JSON: nanos must not be greater than 99999999`,
    );
  }
  let timezoneSuffix = "Z";
  if (timestamp.nanos > 0) {
    const nanosStr = (timestamp.nanos + 1000000000).toString().substring(1);
    if (nanosStr.substring(3) === "000000") {
      timezoneSuffix = "." + nanosStr.substring(0, 3) + "Z";
    } else if (nanosStr.substring(6) === "000") {
      timezoneSuffix = "." + nanosStr.substring(0, 6) + "Z";
    } else {
      timezoneSuffix = "." + nanosStr + "Z";
    }
  }
  return new Date(milliseconds).toISOString().replace(".000Z", timezoneSuffix);
}
