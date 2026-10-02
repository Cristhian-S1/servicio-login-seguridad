export interface User {
  id: string;
  email: string;
  password_hash: string;
  is_active: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
}
