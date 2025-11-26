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

import type { MessageShape } from "./types.js";
import { type DescField, type DescMessage, ScalarType } from "./descriptors.js";
import type { ReflectMessage } from "./reflect/reflect-types.js";
import { reflect } from "./reflect/reflect.js";
import { isReflectMessage } from "./reflect/guard.js";

/**
 * Create a deep copy of a message, including extensions and unknown fields.
 */
export function clone<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageShape<Desc> {
  return cloneReflect(reflect(schema, message)).message as MessageShape<Desc>;
}

function cloneReflect(sourceMessage: ReflectMessage): ReflectMessage {
  const clonedMessage = reflect(sourceMessage.desc);
  for (const field of sourceMessage.fields) {
    if (!sourceMessage.isSet(field)) {
      continue;
    }
    switch (field.fieldKind) {
      case "list":
        const list = clonedMessage.get(field);
        for (const item of sourceMessage.get(field)) {
          list.add(cloneSingular(field, item));
        }
        break;
      case "map":
        const map = clonedMessage.get(field);
        for (const entry of sourceMessage.get(field).entries()) {
          map.set(entry[0], cloneSingular(field, entry[1]));
        }
        break;
      default: {
        clonedMessage.set(field, cloneSingular(field, sourceMessage.get(field)));
        break;
      }
    }
  }
  const unknownFields = sourceMessage.getUnknown();
  if (unknownFields && unknownFields.length > 0) {
    clonedMessage.setUnknown([...unknownFields]);
  }
  return clonedMessage;
}

function cloneSingular<T>(field: DescField, value: T): T {
  if (field.message !== undefined && isReflectMessage(value)) {
    return cloneReflect(value) as T;
  }
  if (field.scalar == ScalarType.BYTES && value instanceof Uint8Array) {
    // @ts-expect-error T cannot extend Uint8Array in practice
    return value.slice();
  }
  return value;
}
