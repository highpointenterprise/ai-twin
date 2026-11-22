import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export default async function HomePage() {
  redirect((await currentUser()) ? "/dashboard" : "/login");
}
