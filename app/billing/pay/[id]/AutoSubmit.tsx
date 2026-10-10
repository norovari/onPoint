"use client";
import { useEffect } from "react";

export function AutoSubmit({ formId }: { formId: string }) {
  useEffect(() => {
    const t = setTimeout(() => (document.getElementById(formId) as HTMLFormElement | null)?.submit(), 600);
    return () => clearTimeout(t);
  }, [formId]);
  return null;
}
