import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { RiTimeLine } from "react-icons/ri";
import { Page } from "../components/ui/Page";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { createSocket } from "../lib/socket";
import { sessionStore } from "../lib/sessionStore";
import { normalizeSlug, sessionPath } from "../lib/slug";
import { shortId } from "../lib/format";
import "./Waiting.scss";

export function Waiting() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const knockId = params.get("k") ?? sessionStore.get().knock_id ?? "";
  const cleanSlug = normalizeSlug(slug);
  const displayName = sessionStore.get().display_name ?? "";

  useEffect(() => {
    const socket = createSocket();

    socket.on("connect", () => {
      socket.emit("identify", { slug: cleanSlug, tab_id: sessionStore.tabId });
    });
    socket.on("admitted", (p) => {
      sessionStore.set({
        slug: cleanSlug,
        user_id: p.user_id,
        is_owner: false,
      });
      socket.disconnect();
      navigate(sessionPath(cleanSlug));
    });
    socket.on("rejected", () => {
      socket.disconnect();
      toast("The owner declined your request.", "warn");
      navigate("/");
    });
    socket.on("knock:expired", () => {
      socket.disconnect();
      toast("Your knock expired. Please try again.", "warn");
      navigate("/");
    });
    socket.on("error", (e) => {
      if (e.code === "unauthorized" || e.code === "session_not_found") {
        socket.disconnect();
        toast("This waiting session is no longer valid.", "danger");
        navigate("/");
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [cleanSlug, navigate, toast]);

  async function onCancel() {
    try {
      if (knockId) await api.cancelKnock(cleanSlug, knockId);
    } catch {
      // best effort
    }
    sessionStore.reset();
    navigate("/");
  }

  return (
    <Page>
      <div className="waiting">
        <Card>
          <div className="waiting_body">
            <span className="waiting_icon">
              <RiTimeLine size={32} />
            </span>
            <h1 className="waiting_title">
              Waiting for the owner to admit you…
            </h1>
            <p className="waiting_meta">
              Session <span className="waiting_slug">{cleanSlug}</span>
              {displayName && <> · joining as {displayName}</>}
            </p>
            {knockId && (
              <p className="waiting_idline">
                Your id <span className="waiting_id">#{shortId(knockId)}</span>{" "}
                — share it so the owner can find you.
              </p>
            )}
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </Card>
      </div>
    </Page>
  );
}
