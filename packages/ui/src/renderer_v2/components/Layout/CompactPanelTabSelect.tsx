import React from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X } from "lucide-react";
import type { PanelKind } from "../../layout";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import {
  buildCompactPanelTabMeasureSignature,
  resolveCompactPanelTabMenuScrollbarCompensation,
} from "./compactPanelTabMeasure";
import "./compactPanelTabSelect.scss";

export interface CompactPanelTabOption {
  value: string;
  label: string;
  measureKey?: string;
  leading?: React.ReactNode;
  leadingMeasureKey?: string;
  trailing?: React.ReactNode;
  trailingMeasureKey?: string;
  onClose?: () => void;
  closeTitle?: string;
}

interface CompactPanelTabSelectProps {
  panelId: string;
  panelKind: PanelKind;
  value: string | null;
  options: CompactPanelTabOption[];
  onChange: (next: string) => void;
  className?: string;
  leading?: React.ReactNode;
  leadingMeasureKey?: string;
  trailing?: React.ReactNode;
  trailingMeasureKey?: string;
  actions?: React.ReactNode;
  disabled?: boolean;
}

export const CompactPanelTabSelect: React.FC<CompactPanelTabSelectProps> = ({
  panelId,
  panelKind,
  value,
  options,
  onChange,
  className,
  leading,
  leadingMeasureKey,
  trailing,
  trailingMeasureKey,
  actions,
  disabled,
}) => {
  const STACK_TOGGLE_WIDTH_PX = 24;
  const resolvedValue =
    value && options.some((option) => option.value === value)
      ? value
      : options[0]?.value || "";
  const activeOptionIndex = Math.max(
    0,
    options.findIndex((option) => option.value === resolvedValue),
  );
  const activeOption = options[activeOptionIndex] || null;
  const activeLeading = activeOption?.leading ?? leading;
  const activeTrailing = activeOption?.trailing ?? trailing;
  const hasTrailingActionRail =
    Boolean(actions) || options.some((option) => !!option.onClose);
  const measureSignature = buildCompactPanelTabMeasureSignature({
    panelKind,
    resolvedValue,
    activeLabel: activeOption?.label || "",
    activeMeasureKey: activeOption?.measureKey,
    activeLeadingMeasureKey:
      activeOption?.leadingMeasureKey ?? leadingMeasureKey,
    activeTrailingMeasureKey:
      activeOption?.trailingMeasureKey ?? trailingMeasureKey,
    hasActiveLeading: Boolean(activeLeading),
    hasActiveTrailing: Boolean(activeTrailing),
    hasTrailingActionRail,
    entries: options.map((option) => ({
      value: option.value,
      label: option.label,
      measureKey: option.measureKey,
      leadingMeasureKey: option.leadingMeasureKey,
      trailingMeasureKey: option.trailingMeasureKey,
      hasLeading: Boolean(option.leading),
      hasTrailing: Boolean(option.trailing),
      hasClose: Boolean(option.onClose),
    })),
  });
  const [open, setOpen] = React.useState(false);
  const [shellWidthPx, setShellWidthPx] = React.useState<number | null>(null);
  const [menuPlacementStyle, setMenuPlacementStyle] = React.useState<
    React.CSSProperties | undefined
  >(undefined);
  const [menuScrollbarCompensationPx, setMenuScrollbarCompensationPx] =
    React.useState(0);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const shellWrapRef = React.useRef<HTMLDivElement | null>(null);
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const lastDragStartedAtRef = React.useRef(0);
  const pendingMenuMeasureFrameRef = React.useRef<number | null>(null);

  const cancelPendingMenuMeasurement = React.useCallback(() => {
    if (pendingMenuMeasureFrameRef.current === null) return;
    window.cancelAnimationFrame(pendingMenuMeasureFrameRef.current);
    pendingMenuMeasureFrameRef.current = null;
  }, []);

  const recomputeMenuPlacement = React.useCallback(() => {
    const anchor = shellWrapRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const rect = anchor.getBoundingClientRect();
    const measured = menu.getBoundingClientRect();
    const desiredWidth = Math.max(
      0,
      Math.ceil(rect.width) + menuScrollbarCompensationPx,
    );
    const placement = resolveFloatingMenuPlacement({
      anchorRect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      menuWidth: Math.max(desiredWidth, Math.ceil(measured.width)),
      menuHeight: Math.ceil(measured.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8,
      gap: 1,
      preferredMaxHeight: 320,
    });
    const renderedWidth = Math.min(
      desiredWidth || placement.maxWidth,
      placement.maxWidth || desiredWidth,
    );

    setMenuPlacementStyle((current) => {
      if (
        current?.top === placement.top &&
        current?.left === placement.left &&
        current?.width === renderedWidth &&
        current?.minWidth === renderedWidth &&
        current?.maxWidth === renderedWidth &&
        current?.maxHeight === placement.maxHeight
      ) {
        return current;
      }
      return {
        position: "fixed",
        top: placement.top,
        left: placement.left,
        width: renderedWidth,
        minWidth: renderedWidth,
        maxWidth: renderedWidth,
        maxHeight: placement.maxHeight,
      };
    });
  }, [menuScrollbarCompensationPx]);

  const recomputeMenuScrollbarCompensation = React.useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const menuStyles = window.getComputedStyle(menu);
    const nextCompensation = resolveCompactPanelTabMenuScrollbarCompensation({
      clientWidth: menu.clientWidth,
      offsetWidth: menu.offsetWidth,
      clientHeight: menu.clientHeight,
      scrollHeight: menu.scrollHeight,
      borderLeftWidth: parseFloat(menuStyles.borderLeftWidth || "0"),
      borderRightWidth: parseFloat(menuStyles.borderRightWidth || "0"),
    });

    setMenuScrollbarCompensationPx((current) =>
      current === nextCompensation ? current : nextCompensation,
    );
  }, []);

  const scheduleMenuScrollbarCompensation = React.useCallback(() => {
    cancelPendingMenuMeasurement();
    pendingMenuMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMenuMeasureFrameRef.current = null;
      recomputeMenuScrollbarCompensation();
    });
  }, [cancelPendingMenuMeasurement, recomputeMenuScrollbarCompensation]);

  const recomputeOpenMenuLayout = React.useCallback(() => {
    recomputeMenuPlacement();
    scheduleMenuScrollbarCompensation();
  }, [recomputeMenuPlacement, scheduleMenuScrollbarCompensation]);

  React.useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target && menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    const handleReflow = () => {
      recomputeOpenMenuLayout();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleReflow);
    window.addEventListener("scroll", handleReflow, true);
    recomputeOpenMenuLayout();
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleReflow);
      window.removeEventListener("scroll", handleReflow, true);
    };
  }, [open, recomputeOpenMenuLayout]);

  React.useLayoutEffect(() => {
    if (!open) return;
    recomputeOpenMenuLayout();
  }, [open, recomputeOpenMenuLayout]);

  React.useEffect(() => {
    if (open) return;
    cancelPendingMenuMeasurement();
    setMenuScrollbarCompensationPx(0);
    setMenuPlacementStyle(undefined);
  }, [open, cancelPendingMenuMeasurement]);

  React.useEffect(
    () => cancelPendingMenuMeasurement,
    [cancelPendingMenuMeasurement],
  );

  const measureShellWidth = React.useCallback(() => {
    const shell = shellRef.current;
    const shellStyles = shell ? window.getComputedStyle(shell) : null;
    const shellBorderWidth = shellStyles
      ? Math.ceil(parseFloat(shellStyles.borderLeftWidth || "0")) +
        Math.ceil(parseFloat(shellStyles.borderRightWidth || "0"))
      : 0;
    let nextWidth = Math.ceil((shell?.scrollWidth ?? 0) + shellBorderWidth);
    const measureRows = measureRef.current?.querySelectorAll<HTMLElement>(
      '[data-compact-tab-measure-row="true"]',
    );
    measureRows?.forEach((row) => {
      nextWidth = Math.max(
        nextWidth,
        Math.ceil(row.getBoundingClientRect().width + shellBorderWidth),
      );
    });
    const normalizedWidth = nextWidth > 0 ? nextWidth : null;
    setShellWidthPx((current) =>
      current === normalizedWidth ? current : normalizedWidth,
    );
  }, []);

  React.useLayoutEffect(() => {
    measureShellWidth();
  }, [measureShellWidth, measureSignature]);

  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !rootRef.current) return;
    const observer = new ResizeObserver(() => {
      measureShellWidth();
      if (open) {
        recomputeOpenMenuLayout();
      }
    });
    observer.observe(rootRef.current);
    return () => {
      observer.disconnect();
    };
  }, [measureShellWidth, open, recomputeOpenMenuLayout]);

  const toggleMenu = React.useCallback(() => {
    if (disabled || options.length <= 1) return;
    if (Date.now() - lastDragStartedAtRef.current < 180) {
      return;
    }
    setOpen((current) => !current);
  }, [disabled, options.length]);

  const shellWrapStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!shellWidthPx || shellWidthPx <= 0) return undefined;
    return {
      width: `${shellWidthPx}px`,
    };
  }, [shellWidthPx]);

  const rootStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!shellWidthPx || shellWidthPx <= 0) return undefined;
    return {
      "--compact-tab-cluster-width": `${STACK_TOGGLE_WIDTH_PX + shellWidthPx}px`,
    } as React.CSSProperties;
  }, [shellWidthPx]);

  const menuStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (menuPlacementStyle) {
      return menuPlacementStyle;
    }

    return {
      position: "fixed",
      top: 0,
      left: 0,
      width: shellWidthPx ?? undefined,
      minWidth: shellWidthPx ?? undefined,
      maxWidth: shellWidthPx ?? undefined,
      visibility: "hidden",
    };
  }, [menuPlacementStyle, shellWidthPx]);

  return (
    <div
      ref={rootRef}
      style={rootStyle}
      className={clsx("gyshell-compact-tab-select", className, {
        "is-open": open,
        "is-disabled": disabled || options.length <= 0,
      })}
      data-layout-tab-bar="true"
      data-layout-tab-panel-id={panelId}
      data-layout-tab-kind={panelKind}
    >
      <button
        type="button"
        className={clsx("gyshell-compact-tab-stack-toggle", {
          "is-open": open,
          "is-disabled": disabled || options.length <= 1,
        })}
        tabIndex={disabled ? -1 : 0}
        aria-haspopup={options.length > 1 ? "listbox" : undefined}
        aria-expanded={options.length > 1 ? open : undefined}
        aria-label={`${options.length} stacked tabs`}
        title={`${options.length} stacked tabs`}
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleMenu();
          }
        }}
      >
        <span className="gyshell-compact-tab-stack-deck" aria-hidden="true">
          <span className="gyshell-compact-tab-stack-card is-back" />
          <span className="gyshell-compact-tab-stack-card is-mid" />
          <span className="gyshell-compact-tab-stack-card is-front" />
        </span>
        <span
          className="gyshell-compact-tab-stack-toggle-count"
          aria-hidden="true"
        >
          {options.length}
        </span>
      </button>
      <div
        ref={shellWrapRef}
        className="gyshell-compact-tab-shell-wrap"
        style={shellWrapStyle}
      >
        <div
          ref={shellRef}
          className={clsx("gyshell-compact-tab-select-shell", {
            "is-open": open,
            "is-disabled": disabled || options.length <= 0,
            "has-trailing-actions": hasTrailingActionRail,
          })}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-haspopup={options.length > 1 ? "listbox" : undefined}
          aria-expanded={options.length > 1 ? open : undefined}
          draggable={options.length > 0}
          data-layout-tab-draggable={options.length > 0 ? "true" : undefined}
          data-layout-tab-id={resolvedValue || undefined}
          data-layout-tab-kind={panelKind}
          data-layout-tab-panel-id={panelId}
          data-layout-tab-index={String(activeOptionIndex)}
          onClick={toggleMenu}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleMenu();
            }
          }}
          onDragStart={() => {
            lastDragStartedAtRef.current = Date.now();
            if (open) {
              setOpen(false);
            }
          }}
        >
          <div
            className={clsx("gyshell-compact-tab-trigger", {
              "is-open": open,
              "is-disabled": disabled || options.length <= 0,
            })}
          >
            {activeLeading ? (
              <span className="gyshell-compact-tab-leading">
                {activeLeading}
              </span>
            ) : null}
            <span className="gyshell-compact-tab-label">
              {activeOption?.label || ""}
            </span>
            {activeTrailing ? (
              <span className="gyshell-compact-tab-trailing">
                {activeTrailing}
              </span>
            ) : null}
          </div>
          {hasTrailingActionRail ? (
            <div className="gyshell-compact-tab-select-actions-rail">
              {actions ? (
                actions
              ) : (
                <span
                  className="gyshell-compact-tab-action-rail-placeholder"
                  aria-hidden="true"
                />
              )}
            </div>
          ) : null}
        </div>
        {open && options.length > 1
          ? createPortal(
              <div
                ref={menuRef}
                className="gyshell-compact-tab-menu"
                data-layout-tab-kind={panelKind}
                role="listbox"
                style={menuStyle}
              >
                {options.map((option, index) => {
                  const isActive = option.value === resolvedValue;
                  return (
                    <div
                      key={option.value}
                      className={clsx("gyshell-compact-tab-option", {
                        "is-active": isActive,
                        "is-closable": !!option.onClose,
                        "has-trailing-actions": hasTrailingActionRail,
                      })}
                      data-layout-tab-menu-item="true"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={0}
                      draggable
                      data-layout-tab-draggable="true"
                      data-layout-tab-id={option.value}
                      data-layout-tab-kind={panelKind}
                      data-layout-tab-panel-id={panelId}
                      data-layout-tab-index={String(index)}
                      onClick={() => {
                        if (Date.now() - lastDragStartedAtRef.current < 180) {
                          return;
                        }
                        onChange(option.value);
                        setOpen(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onChange(option.value);
                          setOpen(false);
                        }
                      }}
                      onDragStart={() => {
                        lastDragStartedAtRef.current = Date.now();
                      }}
                    >
                      <div className="gyshell-compact-tab-option-main">
                        {option.leading ? (
                          <span className="gyshell-compact-tab-option-leading">
                            {option.leading}
                          </span>
                        ) : null}
                        <span className="gyshell-compact-tab-option-label">
                          {option.label}
                        </span>
                        {option.trailing ? (
                          <span className="gyshell-compact-tab-option-trailing">
                            {option.trailing}
                          </span>
                        ) : null}
                      </div>
                      {hasTrailingActionRail ? (
                        <div className="gyshell-compact-tab-option-actions-rail">
                          {option.onClose ? (
                            <button
                              type="button"
                              className="gyshell-compact-tab-option-close"
                              title={option.closeTitle}
                              aria-label={option.closeTitle}
                              draggable={false}
                              onClick={(event) => {
                                event.stopPropagation();
                                option.onClose?.();
                              }}
                            >
                              <X size={12} strokeWidth={2.2} />
                            </button>
                          ) : (
                            <span
                              className="gyshell-compact-tab-action-rail-placeholder"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>,
              document.body,
            )
          : null}
        <div
          ref={measureRef}
          className="gyshell-compact-tab-measure"
          aria-hidden="true"
        >
          {options.map((option) => (
            <div
              key={`measure-${option.value}`}
              className="gyshell-compact-tab-measure-row"
              data-compact-tab-measure-row="true"
            >
              <span className="gyshell-compact-tab-measure-main">
                {option.leading ? (
                  <span className="gyshell-compact-tab-option-leading">
                    {option.leading}
                  </span>
                ) : null}
                <span className="gyshell-compact-tab-measure-label">
                  {option.label}
                </span>
                {option.trailing ? (
                  <span className="gyshell-compact-tab-option-trailing">
                    {option.trailing}
                  </span>
                ) : null}
              </span>
              {hasTrailingActionRail ? (
                <span className="gyshell-compact-tab-measure-actions-rail">
                  <span className="gyshell-compact-tab-action-rail-placeholder" />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
