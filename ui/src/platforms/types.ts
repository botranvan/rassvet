import type { CloudInfo, LoginRequest } from "@/lib/session";

/** What every platform's sign-in form gets: the clouds of that platform and the sign-in call. */
export interface PlatformSignInProps {
  clouds: CloudInfo[];
  mutation: { mutate: (req: LoginRequest) => void; isPending: boolean; error: Error | null };
  /** Error loading the clouds, shown with the form's own. */
  error?: Error | null;
  submitLabel: string;
  /** Told which cloud is picked (the sign-in page shows it as the tab's title). */
  onCloudChange?: (cloud: CloudInfo | undefined) => void;
}
