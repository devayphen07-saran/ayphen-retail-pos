CREATE INDEX "idx_audit_logs_user_created" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_store_created" ON "audit_logs" USING btree ("store_fk","created_at");--> statement-breakpoint
CREATE INDEX "idx_device_sessions_user" ON "device_sessions" USING btree ("user_fk");--> statement-breakpoint
CREATE INDEX "idx_device_sessions_device" ON "device_sessions" USING btree ("device_fk");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_ip_created" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_phone_purpose_created" ON "login_attempts" USING btree ("phone","purpose","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_email_created" ON "login_attempts" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_user_created" ON "login_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_otp_requests_phone" ON "otp_requests" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_stores_account" ON "stores" USING btree ("account_fk");