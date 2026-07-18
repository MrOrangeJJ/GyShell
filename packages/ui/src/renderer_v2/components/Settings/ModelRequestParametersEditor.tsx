import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  MODEL_REQUEST_PARAMETERS_MAX_FIELDS,
  isProtectedModelRequestParameter,
  normalizeModelRequestParameters,
  validateModelRequestParameters,
  type JsonValue,
  type ModelRequestParameters,
} from "@gyshell/shared";
import { Select } from "../../platform/Select";

type ParameterValueKind = "text" | "number" | "boolean" | "json";

interface ParameterRow {
  id: number;
  key: string;
  kind: ParameterValueKind;
  rawValue: string;
}

interface EditorResult {
  parameters: ModelRequestParameters;
  errors: Record<string, string>;
  valid: boolean;
}

const COMMON_PARAMETER_KEYS = new Set(["temperature", "top_p"]);

function inferValueKind(value: JsonValue): ParameterValueKind {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

function formatValue(value: JsonValue, kind: ParameterValueKind): string {
  if (kind === "text") return String(value);
  if (kind === "number" || kind === "boolean") return String(value);
  return JSON.stringify(value);
}

function parseValue(row: ParameterRow): JsonValue | undefined {
  if (row.kind === "text") return row.rawValue;
  if (row.kind === "number") {
    const value = Number(row.rawValue.trim());
    return row.rawValue.trim() && Number.isFinite(value) ? value : undefined;
  }
  if (row.kind === "boolean") {
    if (row.rawValue === "true") return true;
    if (row.rawValue === "false") return false;
    return undefined;
  }
  try {
    return JSON.parse(row.rawValue) as JsonValue;
  } catch {
    return undefined;
  }
}

function issueMessage(t: any, code: string, key: string): string {
  if (code === "protected_key") return t.settings.requestParameterProtected(key);
  if (code === "unsafe_key") return t.settings.requestParameterUnsafe;
  if (code === "key_too_long") return t.settings.requestParameterKeyTooLong;
  if (code === "too_deep") return t.settings.requestParameterTooDeep;
  if (code === "too_large") return t.settings.requestParameterTooLarge;
  if (code === "too_many_fields") return t.settings.requestParameterLimit;
  return t.settings.requestParameterInvalidValue;
}

function buildEditorResult(
  common: Record<"temperature" | "top_p", string>,
  rows: ParameterRow[],
  t: any,
): EditorResult {
  const parameters: ModelRequestParameters = {};
  const errors: Record<string, string> = {};

  for (const key of ["temperature", "top_p"] as const) {
    const rawValue = common[key].trim();
    if (!rawValue) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      errors[`common:${key}`] = t.settings.requestParameterInvalidNumber;
      continue;
    }
    parameters[key] = value;
  }

  const seen = new Set(Object.keys(parameters));
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      errors[row.id] = t.settings.requestParameterKeyRequired;
      continue;
    }
    if (COMMON_PARAMETER_KEYS.has(key)) {
      errors[row.id] = t.settings.requestParameterUseCommonField(key);
      continue;
    }
    if (seen.has(key)) {
      errors[row.id] = t.settings.requestParameterDuplicate;
      continue;
    }
    if (isProtectedModelRequestParameter(key)) {
      errors[row.id] = t.settings.requestParameterProtected(key);
      continue;
    }

    const value = parseValue(row);
    if (value === undefined) {
      errors[row.id] = t.settings.requestParameterInvalidValue;
      continue;
    }
    const validation = validateModelRequestParameters({ [key]: value });
    if (!validation.valid) {
      errors[row.id] = issueMessage(t, validation.issues[0]?.code, key);
      continue;
    }
    parameters[key] = value;
    seen.add(key);
  }

  const validation = validateModelRequestParameters(parameters);
  if (!validation.valid) {
    errors.global = issueMessage(
      t,
      validation.issues[0]?.code,
      validation.issues[0]?.key ?? "",
    );
  }

  return {
    parameters: validation.value,
    errors,
    valid: Object.keys(errors).length === 0,
  };
}

export function ModelRequestParametersEditor(props: {
  t: any;
  value?: ModelRequestParameters;
  disabled?: boolean;
  onChange: (value: ModelRequestParameters | undefined) => void;
  onValidationChange: (valid: boolean) => void;
}): React.ReactElement {
  const [normalized] = useState(() =>
    normalizeModelRequestParameters(props.value),
  );
  const nextRowId = useRef(1);
  const [expanded, setExpanded] = useState(Object.keys(normalized).length > 0);
  const [common, setCommon] = useState<Record<"temperature" | "top_p", string>>({
    temperature:
      typeof normalized.temperature === "number"
        ? String(normalized.temperature)
        : "",
    top_p: typeof normalized.top_p === "number" ? String(normalized.top_p) : "",
  });
  const [rows, setRows] = useState<ParameterRow[]>(() =>
    Object.entries(normalized)
      .filter(([key]) => !COMMON_PARAMETER_KEYS.has(key))
      .map(([key, value]) => {
        const kind = inferValueKind(value);
        return {
          id: nextRowId.current++,
          key,
          kind,
          rawValue: formatValue(value, kind),
        };
      }),
  );

  const result = useMemo(
    () => buildEditorResult(common, rows, props.t),
    [common, rows, props.t],
  );

  useEffect(() => {
    props.onValidationChange(result.valid);
    if (!result.valid) return;
    props.onChange(
      Object.keys(result.parameters).length > 0 ? result.parameters : undefined,
    );
  }, [props.onChange, props.onValidationChange, result]);

  const updateRow = (id: number, patch: Partial<ParameterRow>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const kindOptions = [
    { value: "text", label: props.t.settings.requestParameterTypeText },
    { value: "number", label: props.t.settings.requestParameterTypeNumber },
    { value: "boolean", label: props.t.settings.requestParameterTypeBoolean },
    { value: "json", label: "JSON" },
  ];

  const activeCount = Object.keys(result.parameters).length;
  const commonCount = Object.values(common).filter((value) => value.trim()).length;
  const canAdd =
    commonCount + rows.length < MODEL_REQUEST_PARAMETERS_MAX_FIELDS;

  return (
    <section className="request-parameters-editor">
      <button
        type="button"
        className="request-parameters-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        disabled={props.disabled}
      >
        <span className="request-parameters-toggle-title">
          <SlidersHorizontal size={15} />
          {props.t.settings.requestParameters}
        </span>
        <span className="request-parameters-toggle-meta">
          {props.t.settings.requestParameterCount(activeCount)}
          <ChevronDown
            size={14}
            className={expanded ? "is-expanded" : undefined}
          />
        </span>
      </button>

      {expanded ? (
        <div className="request-parameters-content">
          <p className="request-parameters-description">
            {props.t.settings.requestParametersDescription}
          </p>

          <div className="request-parameters-common-grid">
            {(["temperature", "top_p"] as const).map((key) => (
              <label className="request-parameter-common" key={key}>
                <span>{key}</span>
                <input
                  value={common[key]}
                  inputMode="decimal"
                  placeholder={props.t.settings.requestParameterUseDefault}
                  disabled={props.disabled}
                  aria-label={key}
                  onChange={(event) =>
                    setCommon((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  aria-invalid={!!result.errors[`common:${key}`]}
                />
                {result.errors[`common:${key}`] ? (
                  <small>{result.errors[`common:${key}`]}</small>
                ) : null}
              </label>
            ))}
          </div>

          <div className="request-parameters-subheader">
            <span>{props.t.settings.customRequestParameters}</span>
            <span>{props.t.settings.requestParameterJsonHint}</span>
          </div>

          {rows.length > 0 ? (
            <div className="request-parameter-list">
              {rows.map((row) => (
                <div className="request-parameter-item" key={row.id}>
                  <div className="request-parameter-row">
                    <input
                      className="request-parameter-key"
                      value={row.key}
                      placeholder={props.t.settings.requestParameterKey}
                      list="gyshell-request-parameter-presets"
                      spellCheck={false}
                      disabled={props.disabled}
                      onChange={(event) =>
                        updateRow(row.id, { key: event.target.value })
                      }
                      aria-invalid={!!result.errors[row.id]}
                    />
                    <Select
                      className="request-parameter-type"
                      value={row.kind}
                      options={kindOptions}
                      disabled={props.disabled}
                      onChange={(kind) => {
                        const nextKind = kind as ParameterValueKind;
                        updateRow(row.id, {
                          kind: nextKind,
                          rawValue:
                            nextKind === "boolean" &&
                            row.rawValue !== "true" &&
                            row.rawValue !== "false"
                              ? "true"
                              : row.rawValue,
                        });
                      }}
                    />
                    {row.kind === "boolean" ? (
                      <Select
                        className="request-parameter-value request-parameter-boolean"
                        value={row.rawValue}
                        options={[
                          { value: "true", label: "true" },
                          { value: "false", label: "false" },
                        ]}
                        disabled={props.disabled}
                        onChange={(rawValue) => updateRow(row.id, { rawValue })}
                      />
                    ) : (
                      <input
                        className="request-parameter-value"
                        value={row.rawValue}
                        placeholder={props.t.settings.requestParameterValue}
                        spellCheck={false}
                        disabled={props.disabled}
                        onChange={(event) =>
                          updateRow(row.id, { rawValue: event.target.value })
                        }
                        aria-invalid={!!result.errors[row.id]}
                      />
                    )}
                    <button
                      type="button"
                      className="request-parameter-delete"
                      title={props.t.common.delete}
                      aria-label={props.t.common.delete}
                      disabled={props.disabled}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((item) => item.id !== row.id),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {result.errors[row.id] ? (
                    <div className="request-parameter-error">
                      {result.errors[row.id]}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="request-parameters-empty">
              {props.t.settings.noCustomRequestParameters}
            </div>
          )}

          <datalist id="gyshell-request-parameter-presets">
            <option value="max_tokens" />
            <option value="max_completion_tokens" />
            <option value="frequency_penalty" />
            <option value="presence_penalty" />
            <option value="reasoning_effort" />
            <option value="seed" />
            <option value="parallel_tool_calls" />
            <option value="service_tier" />
          </datalist>

          <button
            type="button"
            className="request-parameter-add"
            disabled={props.disabled || !canAdd}
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  id: nextRowId.current++,
                  key: "",
                  kind: "text",
                  rawValue: "",
                },
              ])
            }
          >
            <Plus size={14} />
            {props.t.settings.addRequestParameter}
          </button>
          {result.errors.global ? (
            <div className="request-parameter-error">{result.errors.global}</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
