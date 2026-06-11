import { useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { RiMailOpenLine } from "react-icons/ri";
import { Page } from "../components/ui/Page";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { sessionStore } from "../lib/sessionStore";
import { normalizeSlug, sessionPath } from "../lib/slug";
import "./InviteJoin.scss";

export function InviteJoin() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const cleanSlug = normalizeSlug(slug);
  const code = params.get("invite") ?? "";

  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      toast("Enter a display name to join.", "warn");
      return;
    }
    if (!code) {
      toast("This invite link is missing its code.", "danger");
      return;
    }
    setJoining(true);
    try {
      const { user_id } = await api.redeemInvite(cleanSlug, code, cleanName);
      sessionStore.set({
        slug: cleanSlug,
        user_id,
        is_owner: false,
        display_name: cleanName,
      });
      navigate(sessionPath(cleanSlug));
    } catch (err) {
      const apiCode = err instanceof ApiError ? err.code : "error";
      if (apiCode === "invite_invalid") {
        toast("This invite is no longer valid. Try knocking instead.", "warn");
        navigate(`/?slug=${encodeURIComponent(cleanSlug)}`);
      } else if (apiCode === "session_frozen") {
        toast("This session is halted by the owner. Try again later.", "warn");
      } else if (apiCode === "session_not_found") {
        toast("No session with that ID.", "danger");
        navigate("/");
      } else if (apiCode === "invalid_display_name") {
        toast("That display name is not allowed.", "warn");
      } else if (apiCode === "rate_limited") {
        toast("Too many attempts. Wait a moment.", "warn");
      } else {
        toast("Could not join with this invite. Try again.", "danger");
      }
      setJoining(false);
    }
  }

  return (
    <Page>
      <div className="invite">
        <Card>
          <form className="invite_body" onSubmit={onJoin}>
            <div className="invite_head">
              <span className="invite_icon">
                <RiMailOpenLine size={32} />
              </span>
              <h1 className="invite_title">You're invited to join</h1>
              <p className="invite_meta">
                Session <span className="invite_slug">{cleanSlug}</span>
              </p>
            </div>
            <Input
              label="Your display name"
              placeholder="Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              autoComplete="off"
            />
            <Button
              type="submit"
              loading={joining}
              disabled={!name.trim() || !code}
            >
              Join session
            </Button>
            {!code && (
              <p className="invite_warn">
                This invite link is missing its code. Ask the owner for a fresh
                link.
              </p>
            )}
          </form>
        </Card>
      </div>
    </Page>
  );
}
