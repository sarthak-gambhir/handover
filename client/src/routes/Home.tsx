import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  RiChatNewLine,
  RiChatUploadLine,
  RiFlashlightLine,
  RiShareForwardLine,
  RiUserFollowLine,
  RiStackLine,
  RiGhostLine,
  RiP2pLine,
  RiShieldCheckLine,
  RiLockLine,
  RiShieldUserLine,
} from "react-icons/ri";
import { Page } from "../components/ui/Page";
import { BrandMark } from "../components/ui/BrandMark";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Tabs } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { e2eeSupported } from "../lib/e2ee";
import { sessionStore } from "../lib/sessionStore";
import { normalizeSlug, sessionPath, waitingPath } from "../lib/slug";
import "./Home.scss";

type HomeTab = "create" | "join";

export function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params] = useSearchParams();

  const prefillSlug = params.get("slug") ?? "";
  const [tab, setTab] = useState<HomeTab>(prefillSlug ? "join" : "create");
  const [creating, setCreating] = useState(false);
  const [knocking, setKnocking] = useState(false);
  const [slug, setSlug] = useState(prefillSlug);
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const cleanOwnerName = ownerName.trim();
    if (!cleanOwnerName) {
      toast("Enter your name to create a session.", "warn");
      return;
    }
    setCreating(true);
    try {
      const { slug: newSlug, owner_user_id } = await api.createSession(
        cleanOwnerName,
        readOnly
      );
      sessionStore.set({
        slug: newSlug,
        user_id: owner_user_id,
        is_owner: true,
        display_name: cleanOwnerName,
      });
      navigate(sessionPath(newSlug));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "error";
      if (code === "invalid_display_name")
        toast("That name is not allowed.", "warn");
      else toast("Could not create a session. Try again.", "danger");
      setCreating(false);
    }
  }

  async function onKnock(e: FormEvent) {
    e.preventDefault();
    const cleanSlug = normalizeSlug(slug);
    const cleanName = name.trim();
    if (!cleanSlug || !cleanName) {
      toast("Enter both a session ID and a display name.", "warn");
      return;
    }
    setKnocking(true);
    try {
      const { knock_id } = await api.knock(cleanSlug, cleanName);
      sessionStore.set({
        slug: cleanSlug,
        display_name: cleanName,
        is_owner: false,
        knock_id,
      });
      navigate(waitingPath(cleanSlug, knock_id));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "error";
      if (code === "session_not_found")
        toast("No session with that ID.", "danger");
      else if (code === "session_frozen")
        toast("This session is halted by the owner. Try again later.", "warn");
      else if (code === "knocking_paused")
        toast("The owner has paused new joins.", "warn");
      else if (code === "invalid_display_name")
        toast("That display name is not allowed.", "warn");
      else if (code === "knock_queue_full")
        toast("The waiting room is full. Try later.", "warn");
      else if (code === "rate_limited")
        toast("Too many attempts. Wait a moment.", "warn");
      else toast("Could not knock. Try again.", "danger");
      setKnocking(false);
    }
  }

  return (
    <Page hideAppBar>
      <div className="home">
        <header className="home_hero">
          <BrandMark className="home_mark" size={120} />
          <h1 className="home_title">HandOver</h1>
          <p className="home_tagline">
            Share content privately — your files, your circle, nobody else
            invited.
          </p>
          <p className="home_subtitle">
            Owner-admitted, in-memory file transfer. Nothing is stored after the
            session ends.
          </p>
        </header>

        <div className="home_cards">
          <Card className="home_card home_card_primary">
            <Tabs
              className="home_tabs"
              ariaLabel="Create or join a session"
              value={tab}
              onChange={(id) => setTab(id as HomeTab)}
              items={[
                { id: "create", label: "Create", panelId: "home_panel_create" },
                { id: "join", label: "Join", panelId: "home_panel_join" },
              ]}
            />

            {tab === "create" ? (
              <div
                id="home_panel_create"
                role="tabpanel"
                aria-labelledby="tab_create"
                className="home_panel"
              >
                <div className="home_panel_helpers">
                  <p className="home_panel_helper">
                    Start a private space to share with your circle, where you
                    stay in control.
                  </p>
                  <p className="home_panel_helper">
                    No footprint, no clutter – everything disappears when the
                    session ends.
                  </p>
                </div>

                <hr className="horizontal_divider" />

                <form className="home_form" onSubmit={onCreate}>
                  <Input
                    label="Your name"
                    placeholder="Alex"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    maxLength={32}
                    autoComplete="off"
                  />
                  <label className="home_readonly">
                    <span className="home_readonly_text">
                      <span className="home_readonly_label">
                        <RiShieldUserLine size={16} />
                        Read-only session
                      </span>
                      <span className="home_readonly_hint">
                        Only you can share files; everyone else can download.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      className="home_switch"
                      checked={readOnly}
                      onChange={(e) => setReadOnly(e.target.checked)}
                    />
                  </label>
                  <Button
                    type="submit"
                    loading={creating}
                    disabled={!ownerName.trim()}
                    icon={<RiChatNewLine size={22} />}
                  >
                    Create New Session
                  </Button>
                </form>
              </div>
            ) : (
              <div
                id="home_panel_join"
                role="tabpanel"
                aria-labelledby="tab_join"
                className="home_panel"
              >
                <div className="home_panel_helpers">
                  <p className="home_panel_helper">
                    Request to join. Step inside, share and access session
                    files.
                  </p>
                  <p className="home_panel_helper">
                    No footprint, no clutter – everything disappears when the
                    session ends.
                  </p>
                </div>

                <hr className="horizontal_divider" />

                <form className="home_form" onSubmit={onKnock}>
                  <Input
                    label="Session ID"
                    mono
                    placeholder="purple-otter-77"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    autoComplete="off"
                  />
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
                    loading={knocking}
                    disabled={!slug.trim() || !name.trim()}
                    icon={<RiChatUploadLine size={22} />}
                  >
                    Knock to Join
                  </Button>
                </form>
              </div>
            )}
          </Card>
        </div>

        <ol className="home_steps" aria-label="How it works">
          <li className="home_step">
            <div className="home_step_header">
              <span className="home_step_icon">
                <RiFlashlightLine size={24} />
              </span>
              <div className="home_step_title">Create</div>
            </div>
            <div className="home_step_text">
              <span>Start a private session and become its owner.</span>
            </div>
          </li>
          <li className="home_step">
            <div className="home_step_header">
              <span className="home_step_icon">
                <RiUserFollowLine size={24} />
              </span>
              <div className="home_step_title">Invite</div>
            </div>
            <div className="home_step_text">
              <span>Send the link or ID, then admit people as they knock.</span>
            </div>
          </li>
          <li className="home_step">
            <div className="home_step_header">
              <span className="home_step_icon">
                <RiShareForwardLine size={24} />
              </span>
              <div className="home_step_title">Share</div>
            </div>
            <div className="home_step_text">
              <span>Drop files to hand them to everyone in the room.</span>
            </div>
          </li>
        </ol>

        <ul className="home_trust" aria-label="What makes it private">
          <li>
            <RiStackLine size={20} /> In-memory
          </li>
          <li>
            <RiShieldCheckLine size={20} /> Owner-gated
          </li>
          <li>
            <RiP2pLine size={20} /> Peer-to-peer
          </li>
          {e2eeSupported && (
            <li>
              <RiLockLine size={20} /> End-to-end encrypted
            </li>
          )}
          <li>
            <RiGhostLine size={20} /> Nothing stored
          </li>
        </ul>
      </div>
    </Page>
  );
}
