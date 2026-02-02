import { isWindows } from './platform'
import { WindowsProfileSelect, type ProfileOption } from './windows/WindowsProfileSelect'

export function ProfileSelect({
  value,
  options,
  onChange,
  widthCh
}: {
  value: string
  options: ProfileOption[]
  onChange: (nextId: string) => void
  widthCh: number
}) {
  if (isWindows()) {
    return <WindowsProfileSelect value={value} options={options} onChange={onChange} widthCh={widthCh} />
  }

  // macOS/Linux keep native select (original behavior)
  return (
    <select
      className="profile-dropdown"
      value={value}
      style={{ width: `${widthCh}ch` }}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

