import { useEffect, useMemo, useState } from "react";
import { type Annotation, type AnnotationTarget, KIND_META } from "../../shared/annotation";
import type { Agent } from "../../shared/model";
import * as api from "../api";
import { renderMarkdown } from "../markdown";
import { AnnotationForm, rememberedKind } from "./AnnotationForm";
import { Html } from "./Html";

export interface Composer {
  target: AnnotationTarget;
  context: string;
}

interface Props {
  agent: Agent;
  sessionId: string;
  annotations: Annotation[];
  entryOrder: Map<string, number>;
  orphans: ReadonlySet<string>;
  composer: Composer | null;
  editingId: string | null;
  focusId: string | null;
  onCloseComposer: () => void;
  onEdit: (id: string | null) => void;
  onFocus: (id: string) => void;
  onChanged: () => Promise<void>;
}

export function targetLabel(target: AnnotationTarget): string {
  if (target.quote) return "text";
  if (target.blockIndex !== null) return "block";
  return "message";
}

export function AnnotationPanel(props: Props) {
  const { agent, sessionId, annotations, entryOrder, orphans, composer, editingId, focusId } = props;
  const { onCloseComposer, onEdit, onFocus, onChanged } = props;
  const [hideResolved, setHideResolved] = useState(false);

  const sorted = useMemo(
    () =>
      [...annotations].sort(
        (a, b) =>
          (entryOrder.get(a.target.entryId) ?? 0) - (entryOrder.get(b.target.entryId) ?? 0) ||
          (a.target.blockIndex ?? -1) - (b.target.blockIndex ?? -1) ||
          (a.target.quote?.start ?? -1) - (b.target.quote?.start ?? -1) ||
          a.createdAt - b.createdAt,
      ),
    [annotations, entryOrder],
  );
  const shown = hideResolved ? sorted.filter((a) => !a.resolved) : sorted;
  const unresolved = annotations.filter((a) => !a.resolved).length;

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`ann-card-${focusId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  return (
    <aside className="annotation-panel">
      <div className="panel-head">
        <strong>Annotations</strong>
        <span className="muted">
          {annotations.length} · {unresolved} open
        </span>
        <span className="spacer" />
        <label>
          <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />{" "}
          hide resolved
        </label>
      </div>
      {composer && (
        <div className="reveal">
          <div className="composer">
            <div className="section-label">New annotation · {targetLabel(composer.target)}</div>
            <AnnotationForm
              initial={{ kind: rememberedKind(), note: "", tags: [] }}
              excerpt={composer.context || null}
              submitLabel="Save"
              onSubmit={async (v) => {
                await api.createAnnotation({
                  agent,
                  sessionId,
                  target: composer.target,
                  kind: v.kind,
                  note: v.note,
                  tags: v.tags,
                  context: composer.context,
                });
                onCloseComposer();
                await onChanged();
              }}
              onCancel={onCloseComposer}
            />
          </div>
        </div>
      )}
      {!composer && annotations.length === 0 && (
        <div className="muted pad">
          Select text in the transcript, or use “annotate” on a message, thought, or tool call.
        </div>
      )}
      {shown.map((a) => (
        <AnnotationCard
          key={a.id}
          annotation={a}
          editing={editingId === a.id}
          focused={focusId === a.id}
          orphan={orphans.has(a.id)}
          onEdit={onEdit}
          onFocus={onFocus}
          onChanged={onChanged}
        />
      ))}
    </aside>
  );
}

interface CardProps {
  annotation: Annotation;
  editing: boolean;
  focused: boolean;
  orphan: boolean;
  onEdit: (id: string | null) => void;
  onFocus: (id: string) => void;
  onChanged: () => Promise<void>;
}

function AnnotationCard({ annotation: a, editing, focused, orphan, onEdit, onFocus, onChanged }: CardProps) {
  const excerpt = a.target.quote?.exact ?? a.context;
  return (
    <div
      id={`ann-card-${a.id}`}
      className={`ann-card kind-${a.kind}${focused ? " focus" : ""}${a.resolved ? " resolved" : ""}`}
      onClick={() => onFocus(a.id)}
    >
      <div className="card-head">
        <span className={`pill kind-${a.kind}`}>{KIND_META[a.kind].label}</span>
        <span className="muted">{targetLabel(a.target)}</span>
        <span className="spacer" />
        <label onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={a.resolved}
            onChange={async (e) => {
              await api.updateAnnotation(a.id, { resolved: e.target.checked });
              await onChanged();
            }}
          />{" "}
          done
        </label>
        {!editing && (
          <button
            type="button"
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(a.id);
            }}
          >
            edit
          </button>
        )}
      </div>
      {editing ? (
        <AnnotationForm
          initial={{ kind: a.kind, note: a.note, tags: a.tags }}
          excerpt={excerpt || null}
          submitLabel="Update"
          onSubmit={async (v) => {
            await api.updateAnnotation(a.id, v);
            onEdit(null);
            await onChanged();
          }}
          onCancel={() => onEdit(null)}
          onDelete={async () => {
            await api.deleteAnnotation(a.id);
            onEdit(null);
            await onChanged();
          }}
        />
      ) : (
        <>
          {excerpt && <blockquote className="excerpt">{excerpt}</blockquote>}
          {a.note && <Html className="note md" html={renderMarkdown(a.note)} />}
          {a.tags.length > 0 && (
            <div className="tags">
              {a.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          {orphan && <div className="warn">Quoted text was not found in the current rendering.</div>}
        </>
      )}
    </div>
  );
}
