import React, { forwardRef, useImperativeHandle, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import { isLinux, isWindows } from "../platform";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectHandle {
  toggle: () => void;
  open: () => void;
  close: () => void;
}

interface WindowsSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (next: string) => void;
  disabled?: boolean;
  widthCh?: number;
  className?: string;
  hideArrow?: boolean;
  menuClassName?: string;
  menuZIndex?: number;
}

export const WindowsSelect = forwardRef<SelectHandle, WindowsSelectProps>(
  (
    {
      value,
      options,
      onChange,
      disabled,
      widthCh,
      className,
      hideArrow,
      menuClassName,
      menuZIndex,
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const menuRef = React.useRef<HTMLDivElement>(null);
    const [menuStyle, setMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const active = options.find((o) => o.value === value);
    const platformMenuClassName = React.useMemo(() => {
      if (isWindows()) {
        return "is-platform-windows";
      }
      if (isLinux()) {
        return "is-platform-linux";
      }
      return "";
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        toggle: () => {
          if (disabled) return;
          setOpen((v) => !v);
        },
        open: () => {
          if (disabled) return;
          setOpen(true);
        },
        close: () => setOpen(false),
      }),
      [disabled],
    );

    const recomputeMenuPosition = React.useCallback(() => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      const gap = 4;

      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: vw,
        viewportHeight: vh,
        margin,
        gap,
        preferredMaxHeight: 300,
      });

      setMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, []);

    useLayoutEffect(() => {
      if (!open) return;
      const onDocMouseDown = (e: MouseEvent) => {
        const root = rootRef.current;
        const menu = menuRef.current;
        const target = e.target as Node;
        if (!root) return;
        if (!root.contains(target) && !menu?.contains(target)) {
          setOpen(false);
        }
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      };
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKeyDown);

      // Reposition on scroll/resize so we don't "pierce walls"
      const onReflow = () => recomputeMenuPosition();
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);

      // After mount, measure and position
      recomputeMenuPosition();

      return () => {
        document.removeEventListener("mousedown", onDocMouseDown);
        document.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [open, recomputeMenuPosition]);

    return (
      <div
        ref={rootRef}
        className="win-select"
        style={widthCh ? { width: `${widthCh}ch` } : undefined}
      >
        <button
          type="button"
          className={
            className ? `${className} win-select-trigger` : "win-select-trigger"
          }
          disabled={disabled}
          onClick={(e) => {
            if (disabled) return;
            e.stopPropagation(); // Issue 1 fix: Prevent double-toggle when clicked via parent wrapper
            setOpen((v) => !v);
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          ref={triggerRef}
          title={active?.label || ""}
        >
          <span className="win-select-label">{active?.label || ""}</span>
          {!hideArrow && <ChevronDown size={12} />}
        </button>

        {open &&
          !disabled &&
          createPortal(
            <div
              ref={menuRef}
              className={
                platformMenuClassName
                  ? `win-select-menu ${platformMenuClassName}${menuClassName ? ` ${menuClassName}` : ""}`
                  : `win-select-menu${menuClassName ? ` ${menuClassName}` : ""}`
              }
              role="listbox"
              style={
                menuZIndex
                  ? { ...menuStyle, zIndex: menuZIndex }
                  : menuStyle
              }
            >
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`win-select-option ${o.value === value ? "is-selected" : ""}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={o.value === value}
                  title={o.label}
                >
                  {o.label}
                </button>
              ))}
            </div>,
            document.body,
          )}
      </div>
    );
  },
);
