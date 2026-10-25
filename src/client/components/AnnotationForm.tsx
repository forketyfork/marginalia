import { useEffect, useRef, useState } from "react";
import { ANNOTATION_KINDS, type AnnotationKind, KIND_META } from "../../shared/annotation";

export interface FormValue {
  kind: AnnotationKind;
  note: string;
  tags: string[];
}

interface Props {
  initial: FormValue;
  excerpt: string | null;
  submitLabel: string;
  onSubmit: (value: FormValue) => Promise<void> | void;
  onCancel: () => void;
  onDelete?: () => Promise<void> | void;
}

const LAST_KIND_KEY = "marginalia.lastKind";

export function rememberedKind(): AnnotationKind {
  try {
    const k = localStorage.getItem(LAST_KIND_KEY);
    if (k && (ANNOTATION_KINDS as readonly string[]).includes(k)) return k as AnnotationKind;
  } catch {
    // Fall through to the default kind.
  }
  return "note";
}

export function AnnotationForm({ initial, excerpt, submitLabel, onSubmit, onCancel, onDelete }: Props) {
  const [kind, setKind] = useState(initial.kind);
  const [note, setNote] = useState(initial.note);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        kind,
        note: note.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      try {
        localStorage.setItem(LAST_KIND_KEY, kind);
      } catch {
        // Remembering the kind is a convenience only.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="ann-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        } else if (e.altKey && e.key >= "1" && e.key <= "5") {
          const k = ANNOTATION_KINDS[Number(e.key) - 1];
          if (k) {
            e.preventDefault();
            setKind(k);
          }
        }
      }}
    >
      {excerpt && <blockquote className="excerpt">{excerpt}</blockquote>}
      <div className="kind-picker">
        {ANNOTATION_KINDS.map((k) => (
          <button
            type="button"
            key={k}
            className={`chip kind-${k}${kind === k ? " on" : ""}`}
            onClick={() => setKind(k)}
            title={`${KIND_META[k].description} (⌥${KIND_META[k].shortcut})`}
          >
            {KIND_META[k].label}
          </button>
        ))}
      </div>
      <textarea
        ref={noteRef}
        rows={4}
        placeholder={KIND_META[kind].description}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <input
        type="text"
        placeholder="tags, comma separated"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
      />
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {onDelete && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Delete this annotation?")) void onDelete();
            }}
          >
            Delete
          </button>
        )}
        <span className="hint">⌘↵ save · esc cancel</span>
      </div>
    </form>
  );
}
