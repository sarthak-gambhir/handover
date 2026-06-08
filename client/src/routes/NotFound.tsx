import { useNavigate } from "react-router-dom";
import { RiCompass3Line } from "react-icons/ri";
import { Page } from "../components/ui/Page";
import { StateScreen } from "../components/ui/StateScreen";
import { Button } from "../components/ui/Button";

export function NotFound() {
  const navigate = useNavigate();
  return (
    <Page>
      <StateScreen
        icon={<RiCompass3Line size={30} />}
        title="Page not found"
        helper="The link may be broken or the session has ended."
        action={
          <Button variant="secondary" onClick={() => navigate("/")}>
            Back to home
          </Button>
        }
      />
    </Page>
  );
}
