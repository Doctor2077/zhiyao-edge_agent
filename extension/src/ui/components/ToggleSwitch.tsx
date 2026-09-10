export default function ToggleSwitch({
  checked,
  onChange,
  small,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  small?: boolean;
}) {
  return (
    <span className={`switch${small ? ' switch-sm' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </span>
  );
}
