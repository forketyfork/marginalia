interface Props {
  rect: DOMRect;
  onAnnotate: () => void;
}

export function SelectionToolbar({ rect, onAnnotate }: Props) {
  const top = Math.max(8, rect.top - 40);
  const left = Math.max(8, rect.left + rect.width / 2 - 70);
  return (
    <div className="selection-toolbar" style={{ top, left }}>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onAnnotate}>
        Annotate selection
      </button>
    </div>
  );
}
