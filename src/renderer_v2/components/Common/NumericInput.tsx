import React, { useState, useEffect, useRef } from 'react'

interface NumericInputProps {
  value: number
  onChange: (val: number) => void
  min?: number
  max?: number
  allowFloat?: boolean
  className?: string
  style?: React.CSSProperties
  placeholder?: string
  disabled?: boolean
}

export const NumericInput: React.FC<NumericInputProps> = ({
  value,
  onChange,
  min,
  max,
  allowFloat = false,
  className,
  style,
  placeholder,
  disabled
}) => {
  const [displayValue, setDisplayValue] = useState<string>(value.toString())
  const isFocused = useRef(false)

  useEffect(() => {
    // Core fix logic:
    // Calculate what the "corrected" current display value should be
    const currentParsed = parseFloat(displayValue)
    let currentClamped = currentParsed
    if (!isNaN(currentClamped)) {
      if (min !== undefined) currentClamped = Math.max(min, currentClamped)
      if (max !== undefined) currentClamped = Math.min(max, currentClamped)
    }

    // Sync the display value only when the external value has indeed changed unexpectedly (e.g., reset by another component),
    // and not when it's just a "correction difference" caused by the user typing.
    if (currentClamped !== value && !isFocused.current) {
      setDisplayValue(value.toString())
    }
  }, [value])

  const parsedValue = parseFloat(displayValue)
  const isInvalid = !isNaN(parsedValue) && (
    (min !== undefined && parsedValue < min) || 
    (max !== undefined && parsedValue > max)
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    const regex = allowFloat ? /^[0-9]*\.?[0-9]*$/ : /^[0-9]*$/
    if (!regex.test(raw)) return

    setDisplayValue(raw)

    const val = allowFloat ? parseFloat(raw) : parseInt(raw, 10)
    if (!isNaN(val)) {
      // Always send the "corrected" valid value to the outside
      let clamped = val
      if (min !== undefined) clamped = Math.max(min, clamped)
      if (max !== undefined) clamped = Math.min(max, clamped)
      onChange(clamped)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const step = allowFloat ? 0.1 : 1
      const direction = e.key === 'ArrowUp' ? 1 : -1
      
      const current = parseFloat(displayValue) || 0
      let next = current + direction * step
      
      if (allowFloat) {
        next = Math.round(next * 10) / 10
      }

      if (min !== undefined) next = Math.max(min, next)
      if (max !== undefined) next = Math.min(max, next)
      
      setDisplayValue(next.toString())
      onChange(next)
    }
  }

  const handleFocus = () => {
    isFocused.current = true
  }

  const handleBlur = () => {
    isFocused.current = false
    if (displayValue === '' || isNaN(parseFloat(displayValue))) {
      setDisplayValue(value.toString())
    } else {
      // On blur, although the value in the Store is already corrected,
      // if the user entered "1", we still make it jump back to "6" from the Store,
      // providing visual feedback to tell the user that "this is the final effective value".
      setDisplayValue(value.toString())
    }
  }

  const combinedClassName = `${className || ''} ${isInvalid ? 'is-invalid' : ''}`.trim()

  return (
    <input
      type="text"
      className={combinedClassName}
      style={style}
      value={displayValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
      disabled={disabled}
      inputMode={allowFloat ? 'decimal' : 'numeric'}
    />
  )
}
