"use client";

import { Navbar }  from "@/components/layout/Navbar";
import { Toolbar } from "@/components/layout/Toolbar";
import { Sidebar } from "@/components/layout/Sidebar";
import { DashboardContent } from "./(dashboard)/_dashboard";

export default function RootPage() {
  return (
    <>
      <Navbar />
      <Toolbar />
      <Sidebar />
      <main className="layout-main">
        <DashboardContent />
      </main>
    </>
  );
}
