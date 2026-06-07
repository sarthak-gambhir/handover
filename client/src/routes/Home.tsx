import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FaHandshakeAngle, FaPlus, FaDoorOpen } from 'react-icons/fa6';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { api, ApiError } from '../lib/api';
import { sessionStore } from '../lib/sessionStore';
import { normalizeSlug, sessionPath, waitingPath } from '../lib/slug';
import './Home.scss';

export function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params] = useSearchParams();

  const [creating, setCreating] = useState(false);
  const [knocking, setKnocking] = useState(false);
  const [slug, setSlug] = useState(params.get('slug') ?? '');
  const [name, setName] = useState('');

  async function onCreate() {
    setCreating(true);
    try {
      const { slug: newSlug, owner_user_id } = await api.createSession();
      sessionStore.set({
        slug: newSlug,
        user_id: owner_user_id,
        is_owner: true,
        display_name: 'You',
      });
      navigate(sessionPath(newSlug));
    } catch {
      toast('Could not create a session. Try again.', 'danger');
      setCreating(false);
    }
  }

  async function onKnock(e: FormEvent) {
    e.preventDefault();
    const cleanSlug = normalizeSlug(slug);
    const cleanName = name.trim();
    if (!cleanSlug || !cleanName) {
      toast('Enter both a session ID and a display name.', 'warn');
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
      const code = err instanceof ApiError ? err.code : 'error';
      if (code === 'session_not_found') toast('No session with that ID.', 'danger');
      else if (code === 'knocking_paused') toast('The owner has paused new joins.', 'warn');
      else if (code === 'invalid_display_name') toast('That display name is not allowed.', 'warn');
      else if (code === 'knock_queue_full') toast('The waiting room is full. Try later.', 'warn');
      else if (code === 'rate_limited') toast('Too many attempts. Wait a moment.', 'warn');
      else toast('Could not knock. Try again.', 'danger');
      setKnocking(false);
    }
  }

  return (
    <div className="home">
      <header className="home_header">
        <FaHandshakeAngle className="home_logo" size={28} />
        <h1 className="home_title">HandOver</h1>
        <p className="home_tagline">
          Share content privately — your files, your circle, nobody else invited.
        </p>
        <p className="home_subtitle">
          Owner-admitted, in-memory file transfer. Nothing is stored after the session ends.
        </p>
      </header>

      <div className="home_cards">
        <Card title="Create a session" helper="You become the owner and admit others by approving their knock.">
          <Button onClick={onCreate} loading={creating} icon={<FaPlus size={18} />}>
            Create new session
          </Button>
        </Card>

        <Card title="Join a session" helper="Enter the session ID someone shared with you and knock to request entry.">
          <form className="home_join_form" onSubmit={onKnock}>
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
            <Button type="submit" variant="secondary" loading={knocking} icon={<FaDoorOpen size={18} />}>
              Knock
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
