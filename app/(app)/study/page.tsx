"use client";

import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
} from "@/components/ui";
import { getDb } from "@/lib/sync/write";
import { useStudy } from "@/components/study/useStudy";
import { SubjectModal, TopicManager } from "@/components/study/manage";
import { ManualStudyForm, StudyTimer } from "@/components/study/timer";
import { StudyHistory, StudyTotals } from "@/components/study/history";
import type { Subject } from "@/lib/types";

export default function StudyPage() {
  const data = useStudy();
  const { subjects, topics, sessions } = data;
  const [addingSubject, setAddingSubject] = useState(false);
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);
  const [managingTopics, setManagingTopics] = useState<Subject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleSubjectActive(s: Subject) {
    setBusy(true);
    setError(null);
    try {
      const db = getDb();
      await db.update("subjects", s.id, { is_active: !s.is_active });
      data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update subject.");
    } finally {
      setBusy(false);
    }
  }

  if (data.loading) return <LoadingBlock />;
  if (data.error)
    return <ErrorState message={data.error} onRetry={data.refresh} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Study</h1>
          <p className="page-sub">What you study, and how long it actually took.</p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setAddingSubject(true)}>
          + Subject
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
      )}

      {/* timer */}
      <section aria-label="Study timer">
        <h2 className="section-title mb-2">Timer</h2>
        <div className="surface card-pad">
          <StudyTimer subjects={subjects} topics={topics} onSaved={data.refresh} />
        </div>
      </section>

      {/* manual entry */}
      <section aria-label="Log a session manually">
        <h2 className="section-title mb-2">Log manually</h2>
        <div className="surface card-pad">
          <ManualStudyForm
            subjects={subjects}
            topics={topics}
            onSaved={data.refresh}
          />
        </div>
      </section>

      {/* totals */}
      <section aria-label="Study totals">
        <h2 className="section-title mb-2">Overview</h2>
        <StudyTotals sessions={sessions} subjects={subjects} />
      </section>

      {/* history */}
      <section aria-label="Study history">
        <h2 className="section-title mb-2">History</h2>
        <StudyHistory sessions={sessions} subjects={subjects} topics={topics} />
      </section>

      {/* subjects */}
      <section aria-label="Subjects and topics">
        <h2 className="section-title mb-2">Subjects & topics</h2>
        {subjects.length === 0 ? (
          <EmptyState
            title="No subjects yet"
            body="Create your first subject — Mathematics, Programming, whatever you're actually studying."
            action={
              <button className="btn-primary" onClick={() => setAddingSubject(true)}>
                Create subject
              </button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {subjects.map((s) => {
              const topicCount = topics.filter((t) => t.subject_id === s.id).length;
              return (
                <div key={s.id} className="surface card-pad !p-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium t-primary">
                        {s.name}
                        {!s.is_active && (
                          <span className="text-xs t-faint font-normal"> · paused</span>
                        )}
                      </p>
                      <p className="text-xs t-faint">
                        {topicCount} topic{topicCount === 1 ? "" : "s"}
                        {s.description ? ` · ${s.description}` : ""}
                      </p>
                    </div>
                    <button
                      className="btn-ghost !min-h-[40px] !px-3 text-xs shrink-0"
                      disabled={busy}
                      onClick={() =>
                        setManagingTopics(managingTopics?.id === s.id ? null : s)
                      }
                    >
                      Topics
                    </button>
                    <button
                      className="btn-ghost !min-h-[40px] !px-3 text-xs shrink-0"
                      disabled={busy}
                      onClick={() => setEditingSubject(s)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-ghost !min-h-[40px] !px-3 text-xs shrink-0"
                      disabled={busy}
                      onClick={() => toggleSubjectActive(s)}
                    >
                      {s.is_active ? "Pause" : "Activate"}
                    </button>
                  </div>
                  {managingTopics?.id === s.id && (
                    <div className="mt-3 pt-3 border-t hairline">
                      <TopicManager
                        subject={s}
                        topics={topics}
                        onChanged={data.refresh}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {addingSubject && (
        <SubjectModal
          title="New subject"
          onClose={() => setAddingSubject(false)}
          onSaved={data.refresh}
        />
      )}
      {editingSubject && (
        <SubjectModal
          title="Edit subject"
          initial={editingSubject}
          onClose={() => setEditingSubject(null)}
          onSaved={data.refresh}
        />
      )}
    </div>
  );
}
