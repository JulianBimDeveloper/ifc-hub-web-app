import { Navbar }  from "@/components/layout/Navbar";
import { Toolbar } from "@/components/layout/Toolbar";
import { Sidebar } from "@/components/layout/Sidebar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <Toolbar />
      <Sidebar />
      <main className="layout-main">
        {children}
      </main>
    </>
  );
}
