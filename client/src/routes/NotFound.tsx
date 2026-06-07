import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/EmptyState';
import { FaFileCircleQuestion } from 'react-icons/fa6';
import './NotFound.scss';

export function NotFound() {
  return (
    <div className="not_found">
      <EmptyState
        icon={<FaFileCircleQuestion size={32} />}
        title="Page not found"
        helper="The link may be broken or the session has ended."
      />
      <Link className="not_found_link" to="/">
        Back to home
      </Link>
    </div>
  );
}
