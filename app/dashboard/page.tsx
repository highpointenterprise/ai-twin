import { requireUser } from "@/lib/session";
import Dashboard from "./dashboard";
export default async function DashboardPage() {
  const user = await requireUser();
  return <Dashboard user={{ id: user.id, name: user.name, email: user.email }} />;
}
