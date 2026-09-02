import { readOpaqueNonBlankWellFormedString } from "@gyshell/shared";
import {
  normalizeDetachedWindowTabOwnership,
  type NormalizedDetachedWindowTabOwnership,
} from "./DetachedWindowRegistry";

export type AppWindowRole = "main" | "detached";

export interface AppWindowCreationOptions {
  role?: AppWindowRole;
  detachedStateToken?: string;
  sourceClientId?: string;
  tabOwnership?: unknown;
  safeMode?: boolean;
}

export type NormalizedAppWindowCreationOptions =
  | {
      role: "main";
      safeMode: boolean;
    }
  | {
      role: "detached";
      detachedStateToken: string;
      sourceClientId: string;
      tabOwnership: NormalizedDetachedWindowTabOwnership;
      safeMode: boolean;
    };

const ALLOWED_KEYS = [
  "role",
  "detachedStateToken",
  "sourceClientId",
  "tabOwnership",
  "safeMode",
] as const;

const isPlainRecord = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasOnlyKeys = (value: Record<string, unknown>): boolean => {
  try {
    const allowed = new Set<string>(ALLOWED_KEYS);
    return Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    );
  } catch {
    return false;
  }
};

const readTransportId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return readOpaqueNonBlankWellFormedString(value.trim());
};

/**
 * Admits every native window creation request before settings, display, or
 * BrowserWindow side effects. Detached transport IDs are trimmed by their URL
 * transport contract; tab identities remain exact inside the ownership parser.
 */
export const normalizeAppWindowCreationOptions = (
  value: unknown,
): NormalizedAppWindowCreationOptions | null => {
  try {
    if (value === undefined) {
      return { role: "main", safeMode: false };
    }
    if (!isPlainRecord(value) || !hasOnlyKeys(value)) {
      return null;
    }

    if (
      hasOwn(value, "role") &&
      value.role !== "main" &&
      value.role !== "detached"
    ) {
      return null;
    }
    if (
      hasOwn(value, "safeMode") &&
      typeof value.safeMode !== "boolean"
    ) {
      return null;
    }

    const role = value.role === "detached" ? "detached" : "main";
    const safeMode = value.safeMode === true;
    if (role === "main") {
      if (
        hasOwn(value, "detachedStateToken") ||
        hasOwn(value, "sourceClientId") ||
        hasOwn(value, "tabOwnership")
      ) {
        return null;
      }
      return { role, safeMode };
    }

    if (
      !hasOwn(value, "detachedStateToken") ||
      !hasOwn(value, "sourceClientId") ||
      !hasOwn(value, "tabOwnership") ||
      value.tabOwnership === undefined
    ) {
      return null;
    }
    const detachedStateToken = readTransportId(value.detachedStateToken);
    const sourceClientId = readTransportId(value.sourceClientId);
    const tabOwnership = normalizeDetachedWindowTabOwnership(
      value.tabOwnership,
    );
    if (!detachedStateToken || !sourceClientId || !tabOwnership) {
      return null;
    }

    return {
      role,
      detachedStateToken,
      sourceClientId,
      tabOwnership,
      safeMode,
    };
  } catch {
    return null;
  }
};
