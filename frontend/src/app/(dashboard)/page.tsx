// This page is intentionally identical to app/page.tsx.
// app/page.tsx handles "/" in the root layout; this file is kept
// as the canonical source only for the (dashboard) layout context.
import { DashboardContent } from "./_dashboard";
import { Navbar } from "@/components/layout/Navbar";
import { Sidebar } from "@/components/layout/Sidebar";

export default function DashboardPage() {
  return (
    <>
      <Navbar />
      <Sidebar />
      <main className="layout-main">
        <DashboardContent />
      </main>
    </>
  );
}
