import { useNavigate, useOutletContext } from "react-router-dom";
import { RulesManager } from "../components/RulesManager";
import type { AppOutletContext } from "../layout/AppLayout";

export function RulesPage() {
  const { reviewerName } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();

  return (
    <div className="rules-page">
      <RulesManager
        open
        onClose={() => navigate("/")}
        onChanged={() => {
          window.dispatchEvent(new Event("dic-rules-changed"));
        }}
        reviewerName={reviewerName}
      />
    </div>
  );
}
