import { z } from 'zod';

export const CreateLocationDtoSchema = z.object({
  name:       z.string().min(1).max(100),
  is_default: z.boolean().optional(),
});
export type CreateLocationDto = z.infer<typeof CreateLocationDtoSchema>;

export const UpdateLocationDtoSchema = z
  .object({
    name:   z.string().min(1).max(100).optional(),
    enable: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.enable !== undefined, {
    message: 'name or enable is required',
  });
export type UpdateLocationDto = z.infer<typeof UpdateLocationDtoSchema>;

export const AssignLocationUsersDtoSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(50),
});
export type AssignLocationUsersDto = z.infer<typeof AssignLocationUsersDtoSchema>;
