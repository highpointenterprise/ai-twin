import type { ReactNode } from "react";
export function SummaryCard({
  title,
  value,
  detail,
  onEdit,
}: {
  title: string;
  value: ReactNode;
  detail: string;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      className="assistant-summary"
      onClick={onEdit}
      aria-label={`Edit ${title.toLowerCase()}`}
    >
      <span className="summary-label">
        {title}
        <span aria-hidden="true">Edit</span>
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}
