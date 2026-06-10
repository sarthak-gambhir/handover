import { useEffect, useMemo, useState } from "react";
import { RiCheckLine, RiCloseLine, RiInbox2Line } from "react-icons/ri";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import { KnockQueueItem, type Knock } from "./KnockQueueItem";
import "./KnockQueueModal.scss";

interface KnockQueueModalProps {
  open: boolean;
  onClose: () => void;
  knockers: Knock[];
  paused: boolean;
  onAdmit: (id: string) => void;
  onReject: (id: string) => void;
}

export function KnockQueueModal({
  open,
  onClose,
  knockers,
  paused,
  onAdmit,
  onReject,
}: KnockQueueModalProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Clear transient state whenever the dialog is closed.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected(new Set());
    }
  }, [open]);

  // Drop selections for knockers that are no longer waiting (admitted/left).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(knockers.map((k) => k.knock_id));
      const next = new Set<string>();
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [knockers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return knockers;
    // Match the display name or the knock id (full hex or the short `#xxxx`
    // shown on each row, which is a suffix of the full id).
    return knockers.filter(
      (k) =>
        k.display_name.toLowerCase().includes(q) ||
        k.knock_id.toLowerCase().includes(q.replace(/^#/, "")),
    );
  }, [knockers, query]);

  const filteredIds = filtered.map((k) => k.knock_id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const selectedCount = selected.size;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const id of filteredIds) next.delete(id);
      else for (const id of filteredIds) next.add(id);
      return next;
    });
  }

  function admitSelected() {
    for (const id of selected) onAdmit(id);
    setSelected(new Set());
  }

  function rejectSelected() {
    for (const id of selected) onReject(id);
    setSelected(new Set());
  }

  const footer =
    selectedCount > 0 ? (
      <>
        <Button
          variant="ghost"
          icon={<RiCloseLine size={16} />}
          onClick={rejectSelected}
        >
          Reject {selectedCount}
        </Button>
        <Button
          variant="primary"
          icon={<RiCheckLine size={16} />}
          onClick={admitSelected}
        >
          Admit {selectedCount}
        </Button>
      </>
    ) : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="knock_modal"
      showClose
      title={
        <span className="knock_modal_title">
          Knock queue
          {paused && <Badge variant="warn">paused</Badge>}
        </span>
      }
      footer={footer}
    >
      <div className="knock_modal_body">
        <Input
          type="search"
          placeholder="Search by name or id"
          aria-label="Search knock requests by name or id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {knockers.length === 0 ? (
          <EmptyState
            icon={<RiInbox2Line size={32} />}
            title="No one is waiting"
            helper="Knock requests will appear here as people ask to join."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<RiInbox2Line size={32} />}
            title="No matches"
            helper={`Nothing matches “${query.trim()}”.`}
          />
        ) : (
          <>
            <label className="knock_modal_selectall">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleAll}
              />
              <span>
                Select all{query.trim() ? " matching" : ""} ({filteredIds.length}
                )
              </span>
            </label>
            <ul className="knock_modal_list">
              {filtered.map((k) => (
                <KnockQueueItem
                  key={k.knock_id}
                  knock={k}
                  selectable
                  selected={selected.has(k.knock_id)}
                  onToggleSelect={toggle}
                  onAdmit={onAdmit}
                  onReject={onReject}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
