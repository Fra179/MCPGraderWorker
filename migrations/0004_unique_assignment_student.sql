-- One submission per student per assignment. Fails if duplicates already exist: delete them first.
CREATE UNIQUE INDEX idx_submissions_assignment_student ON submissions (assignment_name, student_id);
