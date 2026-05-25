import apolloMark from "@/assets/apollo-mark.png";

type Props = { className?: string };

/** APOLLO mark — Tri-Orbit System (official brand logo). */
export function ApolloMark({ className }: Props) {
  return (
    <img
      src={apolloMark}
      alt="APOLLO"
      className={className}
      draggable={false}
    />
  );
}
