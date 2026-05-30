import { FutardHeader } from "@/components/futard-header";
import { TokenCardSkeleton } from "@/components/landing-page";

export default function TokensLoading() {
  return (
    <main className="futardLanding">
      <FutardHeader searchPlaceholder="Search token / CA" />
      <section className="tokenDirectory" aria-label="Loading tokens">
        <div className="sectionBar">
          <div>
            <span>ALL LAUNCHED</span>
            <strong>Graduated tokens</strong>
          </div>
          <span className="skeletonBlock skeletonPill" />
        </div>
        <div className="tokenGrid directory">
          {Array.from({ length: 8 }).map((_, index) => <TokenCardSkeleton key={index} />)}
        </div>
      </section>
    </main>
  );
}
