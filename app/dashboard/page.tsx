import { requireUser } from "@/lib/session";
import { LogoutButton } from "@/app/components/logout-button";
import Dashboard from "./dashboard";

export default async function DashboardPage() {
  const user = await requireUser();
  return (
    <>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3 px-4 pt-4 md:px-6">
        <span className="text-sm text-zinc-500">{user.name}</span>
        <LogoutButton />
      </div>
      <Dashboard />
    </>
  );
}
