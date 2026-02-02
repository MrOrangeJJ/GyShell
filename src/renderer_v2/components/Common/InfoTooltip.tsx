import React, { useState, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'
import './infoTooltip.scss'

interface InfoTooltipProps {
  content: string | React.ReactNode
  children?: React.ReactNode
  position?: 'top' | 'bottom' | 'left' | 'right'
}

export const InfoTooltip: React.FC<InfoTooltipProps> = ({ content, children, position = 'top' }) => {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const updatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) return

    const triggerRect = triggerRef.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()
    const padding = 8

    let top = 0
    let left = 0

    // Initial position based on preferred side
    switch (position) {
      case 'top':
        top = triggerRect.top - tooltipRect.height - padding
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
        break
      case 'bottom':
        top = triggerRect.bottom + padding
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
        break
      case 'left':
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
        left = triggerRect.left - tooltipRect.width - padding
        break
      case 'right':
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
        left = triggerRect.right + padding
        break
    }

    // Boundary detection & adjustment
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    // Horizontal adjustment
    if (left < padding) left = padding
    if (left + tooltipRect.width > viewportWidth - padding) {
      left = viewportWidth - tooltipRect.width - padding
    }

    // Vertical adjustment
    if (top < padding) {
      // If top is too high, try bottom
      if (position === 'top') top = triggerRect.bottom + padding
      else top = padding
    }
    if (top + tooltipRect.height > viewportHeight - padding) {
      // If bottom is too low, try top
      if (position === 'bottom') top = triggerRect.top - tooltipRect.height - padding
      else top = viewportHeight - tooltipRect.height - padding
    }

    setCoords({ top, left })
  }

  useEffect(() => {
    if (visible) {
      updatePosition()
      window.addEventListener('resize', updatePosition)
      window.addEventListener('scroll', updatePosition, true)
    }
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [visible])

  return (
    <div 
      className="info-tooltip-trigger" 
      ref={triggerRef}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children || <Info size={14} className="info-icon" />}
      
      {visible && (
        <div 
          className={`info-tooltip-box is-visible`}
          ref={tooltipRef}
          style={{ 
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            zIndex: 10000
          }}
        >
          {content}
        </div>
      )}
    </div>
  )
}
