import { forwardRef } from 'react'
import { WindowsSelect, type SelectOption, type SelectHandle } from './windows/WindowsSelect'

export interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (next: string) => void
  disabled?: boolean
  widthCh?: number
  /** Keep existing trigger look by passing the original className used on <select>. */
  className?: string
  /** Hide the chevron indicator (useful when original mac design has no visible arrow) */
  hideArrow?: boolean
}

export const Select = forwardRef<SelectHandle, SelectProps>(({
  value,
  options,
  onChange,
  disabled,
  widthCh,
  className,
  hideArrow
}, ref) => {
  // Note: Native <select> cannot separate trigger styling from the OS popup.
  // We use a single custom Select implementation across all platforms for consistent UI.
  return (
    <WindowsSelect
      ref={ref}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      widthCh={widthCh}
      className={className}
      hideArrow={hideArrow}
    />
  )
})
