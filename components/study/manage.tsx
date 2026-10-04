"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ConfirmInline, Field, Modal } from "@/components/ui";
import { topicsFor } from "./useStudy";
import type { Subject, Topic } from "@/lib/types";

// ---------------------------------------------------------------------------
// SubjectForm — create / edit a subject
// ---------------------------------------------------------------------------

export function SubjectForm({
  initial,
  onSaved,
}: {
  initial?: Subject | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("Give the subject a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      const payload = {
        owner: user.id,
        name: name.trim(),
        description: description.trim() || null,
        is_active: isActive,
      };
      const { error } = initial
        ? await supabase.from("subjects").update(payload).eq("id", initial.id)
        : await supabase.from("subjects").insert(payload);
      if (error) throw error;
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save subject.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mathematics"
          autoFocus
        />
      </Field>
      <Field label="Description (optional)">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this about?"
        />
      </Field>
      <label className="flex items-center gap-3 text-sm t-primary cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="w-5 h-5 accent-[#5A6AE0]"
        />
        Active
      </label>
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <button className="btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : initial ? "Save changes" : "Create subject"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopicManager — topics inside one subject
// ---------------------------------------------------------------------------

export function TopicManager({
  subject,
  topics,
  onChanged,
}: {
  subject: Subject;
  topics: Topic[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<Topic | null>(null);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = topicsFor(topics, subject.id);

  async function authed() {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in.");
    return { supabase, user };
  }

  async function saveTopic() {
    const n = name.trim();
    if (!n) {
      setError("Give the topic a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { supabase, user } = await authed();
      if (editing) {
        const { error } = await supabase
          .from("topics")
          .update({
            name: n,
            description: description.trim() || null,
          })
          .eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("topics").insert({
          owner: user.id,
          subject_id: subject.id,
          name: n,
          description: description.trim() || null,
          sort_order: list.length + 1,
        });
        if (error) throw error;
      }
      setName("");
      setDescription("");
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save topic.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(t: Topic) {
    setBusy(true);
    try {
      const { supabase } = await authed();
      const { error } = await supabase
        .from("topics")
        .update({ is_active: !t.is_active })
        .eq("id", t.id);
      if (error) throw error;
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update topic.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTopic(t: Topic) {
    setBusy(true);
    setError(null);
    try {
      const { supabase } = await authed();
      const { error } = await supabase.from("topics").delete().eq("id", t.id);
      if (error) throw error;
      setDeleting(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete topic.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(t: Topic) {
    setEditing(t);
    setName(t.name);
    setDescription(t.description ?? "");
  }

  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
        <p className="text-sm t-secondary">
          No topics yet — break {subject.name} into smaller pieces below.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map((t) => (
            <li
              key={t.id}
              className="surface card-pad !p-3 flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm t-primary font-medium">
                  {t.name}
                  {!t.is_active && (
                    <span className="text-xs t-faint font-normal"> · paused</span>
                  )}
                </p>
                {t.description && (
                  <p className="text-xs t-faint truncate">{t.description}</p>
                )}
              </div>
              <button
                className="btn-ghost !min-h-[36px] !px-2.5 text-xs shrink-0"
                disabled={busy}
                onClick={() => toggleActive(t)}
              >
                {t.is_active ? "Pause" : "Activate"}
              </button>
              <button
                className="btn-ghost !min-h-[36px] !px-2.5 text-xs shrink-0"
                disabled={busy}
                onClick={() => startEdit(t)}
              >
                Edit
              </button>
              <button
                className="btn-ghost !min-h-[36px] !px-2.5 text-xs shrink-0 text-red-500 dark:text-red-400"
                disabled={busy}
                onClick={() => setDeleting(t)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmInline
          message={`Delete “${deleting.name}”? Past sessions keep working — they just lose the topic link.`}
          confirmLabel="Delete"
          onConfirm={() => removeTopic(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      <div className="surface-elevated card-pad !p-3 flex flex-col gap-3">
        <p className="text-sm font-medium t-primary">
          {editing ? `Edit “${editing.name}”` : "Add topic"}
        </p>
        <Field label="Topic name">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Linear Algebra"
          />
        </Field>
        <Field label="Description (optional)">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does it cover?"
          />
        </Field>
        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={busy} onClick={saveTopic}>
            {busy ? "Saving…" : editing ? "Save topic" : "Add topic"}
          </button>
          {editing && (
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setName("");
                setDescription("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SubjectModal({
  title,
  initial,
  onClose,
  onSaved,
}: {
  title: string;
  initial?: Subject | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <SubjectForm
        initial={initial}
        onSaved={() => {
          onSaved();
          onClose();
        }}
      />
    </Modal>
  );
}
