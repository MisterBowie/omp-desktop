export type NavigationIntentController = {
  begin: () => number;
  isCurrent: (intent: number) => boolean;
};

export function createNavigationIntentController(): NavigationIntentController {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (intent) => intent === current,
  };
}
