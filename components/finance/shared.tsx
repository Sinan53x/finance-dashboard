"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function KpiCard({
  title,
  value,
  sub,
  children,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <div className="font-mono text-2xl font-semibold tabular-nums">
          {value}
        </div>
        {sub && (
          <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

export function Section({
  title,
  sub,
  children,
  className,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("grid grid-rows-[auto_1fr] gap-3", className)}>
      <div>
        <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </section>
  );
}
