import React from "react";
import { FileText } from "lucide-react";

interface PlanApprovalCardProps {
  children: React.ReactNode;
}

export default function PlanApprovalCard({ children }: PlanApprovalCardProps) {
  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium uppercase tracking-wide text-primary">
          Plan Review
        </span>
      </div>
      {children}
    </div>
  );
}
