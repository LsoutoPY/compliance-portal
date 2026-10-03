const MIN_PASSWORD_LENGTH = 6;

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string
): string | null {
  if (password !== confirmation) {
    return "As senhas não coincidem.";
  }
  return null;
}

export { MIN_PASSWORD_LENGTH };
