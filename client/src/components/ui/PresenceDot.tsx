import { cx } from '../../lib/cx';
import './PresenceDot.scss';

export function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      className={cx('presence_dot', online ? 'presence_dot_online' : 'presence_dot_offline')}
      aria-label={online ? 'online' : 'offline'}
    />
  );
}
