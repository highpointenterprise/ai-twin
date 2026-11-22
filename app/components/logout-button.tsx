"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="flex items-center gap-3">
      {error && <span role="alert" className="text-sm text-red-700">Unable to log out. Try again.</span>}
      <button className="ghost" disabled={pending} onClick={async () => {
        setPending(true);
        setError(false);
        try { await signOut({ callbackUrl: "/login" }); }
        catch { setError(true); setPending(false); }
      }}>{pending ? "Logging out…" : "Log out"}</button>
    </div>
  );
}
