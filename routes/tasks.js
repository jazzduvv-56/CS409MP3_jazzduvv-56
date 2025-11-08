var Task = require('../models/task');
var User = require('../models/user');
var mongoose = require('mongoose');

module.exports = function (router) {

    // Helper to compare ids robustly and keep pendingTasks unique
    function indexOfId(arr, id) {
        if (!arr) return -1;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].toString() === id.toString()) return i;
        }
        return -1;
    }

    function ensureUniquePendingTasks(user) {
        if (user && Array.isArray(user.pendingTasks)) {
            user.pendingTasks = user.pendingTasks.map(function (v) { return v.toString(); })
                .filter(function (v, i, a) { return a.indexOf(v) === i; });
        }
    }

    // Collection route
    var tasksRoute = router.route('/tasks');

    // GET /api/tasks - Get all tasks with query parameters
    tasksRoute.get(function (req, res) {
        try {
            // Parse query parameters
            var whereQuery = req.query.where ? JSON.parse(req.query.where) : {};
            var sortQuery = req.query.sort ? JSON.parse(req.query.sort) : {};
            var selectQuery = req.query.select ? JSON.parse(req.query.select) : {};
            var skipNum = req.query.skip ? parseInt(req.query.skip) : 0;
            var limitNum = req.query.limit ? parseInt(req.query.limit) : 100; // Default 100 for tasks
            var countQuery = req.query.count === 'true';

            // Build the query
            var query = Task.find(whereQuery);

            // Apply select
            if (Object.keys(selectQuery).length > 0) {
                query = query.select(selectQuery);
            }

            // Apply sort
            if (Object.keys(sortQuery).length > 0) {
                query = query.sort(sortQuery);
            }

            // Apply skip and limit
            query = query.skip(skipNum).limit(limitNum);

            // Execute count or find
            if (countQuery) {
                Task.countDocuments(whereQuery).then(function (count) {
                    res.status(200).json({ message: "OK", data: count });
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            } else {
                query.exec().then(function (tasks) {
                    res.status(200).json({ message: "OK", data: tasks });
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            }
        } catch (err) {
            res.status(400).json({ message: err.message || "Invalid query parameters", data: {} });
        }
    });

    // POST /api/tasks - Create a new task
    tasksRoute.post(function (req, res) {
        // Validate required fields
        if (!req.body.name || !req.body.deadline) {
            return res.status(400).json({ message: "Name and deadline are required", data: {} });
        }

        var task = new Task();
        task.name = req.body.name;
        task.description = req.body.description || "";
        task.deadline = req.body.deadline;
        task.completed = req.body.completed || false;
        task.assignedUser = req.body.assignedUser || "";
        task.assignedUserName = req.body.assignedUserName || "unassigned";

        // If task is assigned to a user, validate user exists first
        if (task.assignedUser && task.assignedUser !== "") {
            // Validate assignedUser is a valid ObjectId string; return 400 if malformed
            if (!mongoose.Types.ObjectId.isValid(task.assignedUser)) {
                return res.status(400).json({ message: "Assigned user id is invalid", data: {} });
            }

            User.findById(task.assignedUser).then(function (user) {
                if (!user) {
                    return res.status(400).json({ message: "Assigned user does not exist", data: {} });
                }

                // Validate assignedUserName matches user's actual name
                if (req.body.assignedUserName && req.body.assignedUserName !== user.name) {
                    return res.status(400).json({ message: "Assigned user name does not match user's actual name", data: {} });
                }

                // User exists and name is valid, proceed with save
                saveTaskWithUser(task, user, res);
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        } else {
            // No user assigned, save task directly
            task.save().then(function (savedTask) {
                res.status(201).json({ message: "Created", data: savedTask });
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        }
    });

    // Helper function to save task with user
    function saveTaskWithUser(task, user, res) {
        task.save().then(function (savedTask) {
            // Update task's assignedUserName to match actual user name
            savedTask.assignedUserName = user.name;
            
            // Only add to pendingTasks if task is not completed
            if (!savedTask.completed && indexOfId(user.pendingTasks, savedTask._id) === -1) {
                user.pendingTasks.push(savedTask._id.toString());
            }
            // Ensure pendingTasks are unique before saving
            ensureUniquePendingTasks(user);

            return Promise.all([savedTask.save(), user.save()]).then(function () {
                res.status(201).json({ message: "Created", data: savedTask });
            });
        }).catch(function (err) {
            res.status(500).json({ message: "Internal server error", data: {} });
        });
    }

    // Individual task route
    var taskRoute = router.route('/tasks/:id');

    // GET /api/tasks/:id - Get a specific task
    taskRoute.get(function (req, res) {
        try {
            var selectQuery = req.query.select ? JSON.parse(req.query.select) : {};
            
            var query = Task.findById(req.params.id);
            
            // Apply select if provided
            if (Object.keys(selectQuery).length > 0) {
                query = query.select(selectQuery);
            }

            query.exec().then(function (task) {
                if (!task) {
                    return res.status(404).json({ message: "Task not found", data: {} });
                }
                res.status(200).json({ message: "OK", data: task });
            }).catch(function (err) {
                // Invalid ObjectId format or other database errors should return 404
                if (err.name === 'CastError') {
                    res.status(404).json({ message: "Task not found", data: {} });
                } else {
                    res.status(500).json({ message: "Internal server error", data: {} });
                }
            });
        } catch (err) {
            res.status(400).json({ message: err.message || "Invalid query parameters", data: {} });
        }
    });

    // PUT /api/tasks/:id - Replace a task
    taskRoute.put(function (req, res) {
        // Validate required fields
        if (!req.body.name || !req.body.deadline) {
            return res.status(400).json({ message: "Name and deadline are required", data: {} });
        }

        Task.findById(req.params.id).then(function (task) {
            if (!task) {
                return res.status(404).json({ message: "Task not found", data: {} });
            }

            var oldAssignedUser = task.assignedUser;
            var newAssignedUser = req.body.assignedUser || "";

            // If assigning to a new user, validate user exists
            if (newAssignedUser && newAssignedUser !== "" && oldAssignedUser !== newAssignedUser) {
                // Validate ObjectId format first
                if (!mongoose.Types.ObjectId.isValid(newAssignedUser)) {
                    return res.status(400).json({ message: "Assigned user id is invalid", data: {} });
                }

                User.findById(newAssignedUser).then(function (user) {
                    if (!user) {
                        return res.status(400).json({ message: "Assigned user does not exist", data: {} });
                    }
                    
                    // Validate assignedUserName matches user's actual name
                    if (req.body.assignedUserName && req.body.assignedUserName !== user.name) {
                        return res.status(400).json({ message: "Assigned user name does not match user's actual name", data: {} });
                    }
                    
                    // User exists and name is valid, proceed with update
                    updateTaskWithValidation(task, oldAssignedUser, newAssignedUser, req, res);
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            } else if (newAssignedUser && newAssignedUser !== "" && oldAssignedUser === newAssignedUser) {
                // Same user - still need to validate assignedUserName if provided
                if (req.body.assignedUserName) {
                    if (!mongoose.Types.ObjectId.isValid(newAssignedUser)) {
                        return res.status(400).json({ message: "Assigned user id is invalid", data: {} });
                    }

                    User.findById(newAssignedUser).then(function (user) {
                        if (user && req.body.assignedUserName !== user.name) {
                            return res.status(400).json({ message: "Assigned user name does not match user's actual name", data: {} });
                        }
                        // Name is valid, proceed with update
                        updateTaskWithValidation(task, oldAssignedUser, newAssignedUser, req, res);
                    }).catch(function (err) {
                        res.status(500).json({ message: "Internal server error", data: {} });
                    });
                } else {
                    // No assignedUserName provided, proceed with update
                    updateTaskWithValidation(task, oldAssignedUser, newAssignedUser, req, res);
                }
            } else {
                // No user assigned, proceed with update
                updateTaskWithValidation(task, oldAssignedUser, newAssignedUser, req, res);
            }
        }).catch(function (err) {
            // Invalid ObjectId for task or other errors
            if (err.name === 'CastError') {
                res.status(404).json({ message: "Task not found", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    });

    // Helper function to update task with validation
    function updateTaskWithValidation(task, oldAssignedUser, newAssignedUser, req, res) {
        // Update task fields
        task.name = req.body.name;
        task.description = req.body.description || "";
        task.deadline = req.body.deadline;
        task.completed = req.body.completed || false;
        task.assignedUser = newAssignedUser;
        task.assignedUserName = req.body.assignedUserName || "unassigned";

        // Save the updated task
        task.save().then(function (updatedTask) {
            var promises = [];

            // Handle two-way consistency
            // If assigned user changed
            if (oldAssignedUser !== newAssignedUser) {
                // Remove from old user's pendingTasks
                if (oldAssignedUser && oldAssignedUser !== "") {
                    promises.push(
                        User.findById(oldAssignedUser).then(function (user) {
                                if (user) {
                                var index = indexOfId(user.pendingTasks, req.params.id);
                                if (index > -1) {
                                    user.pendingTasks.splice(index, 1);
                                    // ensure uniqueness just in case
                                    ensureUniquePendingTasks(user);
                                    return user.save();
                                }
                            }
                        })
                    );
                }

                // Add to new user's pendingTasks (only if not completed)
                if (newAssignedUser && newAssignedUser !== "" && !updatedTask.completed) {
                    promises.push(
                        User.findById(newAssignedUser).then(function (user) {
                                if (user) {
                                if (indexOfId(user.pendingTasks, req.params.id) === -1) {
                                    user.pendingTasks.push(req.params.id);
                                    // Also update assignedUserName to match
                                    updatedTask.assignedUserName = user.name;
                                    // ensure uniqueness before save
                                    ensureUniquePendingTasks(user);
                                    return Promise.all([user.save(), updatedTask.save()]);
                                }
                            }
                        })
                    );
                } else if (newAssignedUser && newAssignedUser !== "") {
                    // Update assignedUserName even if task is completed
                    promises.push(
                        User.findById(newAssignedUser).then(function (user) {
                            if (user) {
                                updatedTask.assignedUserName = user.name;
                                return updatedTask.save();
                            }
                        })
                    );
                }
            } else if (newAssignedUser && newAssignedUser !== "") {
                // Same user, but check if task completion status changed
                        promises.push(
                        User.findById(newAssignedUser).then(function (user) {
                            if (user) {
                                var taskIndex = indexOfId(user.pendingTasks, req.params.id);
                                if (updatedTask.completed && taskIndex > -1) {
                                    // Task completed - remove from pendingTasks
                                    user.pendingTasks.splice(taskIndex, 1);
                                    ensureUniquePendingTasks(user);
                                    return user.save();
                                } else if (!updatedTask.completed && taskIndex === -1) {
                                    // Task uncompleted - add to pendingTasks
                                    user.pendingTasks.push(req.params.id);
                                    ensureUniquePendingTasks(user);
                                    return user.save();
                                }
                            }
                        })
                    );
            }

            Promise.all(promises).then(function () {
                res.status(200).json({ message: "OK", data: updatedTask });
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        }).catch(function (err) {
            res.status(500).json({ message: "Internal server error", data: {} });
        });
    }

    // DELETE /api/tasks/:id - Delete a task
    taskRoute.delete(function (req, res) {
        Task.findById(req.params.id).then(function (task) {
            if (!task) {
                return res.status(404).json({ message: "Task not found", data: {} });
            }

            var assignedUser = task.assignedUser;

            // Delete the task
            Task.findByIdAndDelete(req.params.id).then(function () {
                // Remove from assigned user's pendingTasks
                if (assignedUser && assignedUser !== "") {
                    User.findById(assignedUser).then(function (user) {
                            if (user) {
                            var index = indexOfId(user.pendingTasks, req.params.id);
                            if (index > -1) {
                                user.pendingTasks.splice(index, 1);
                                ensureUniquePendingTasks(user);
                                return user.save().then(function () {
                                    res.status(204).send();
                                });
                            }
                        }
                        res.status(204).send();
                    }).catch(function (err) {
                        res.status(500).json({ message: "Internal server error", data: {} });
                    });
                } else {
                    res.status(204).send();
                }
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        }).catch(function (err) {
            // Invalid ObjectId for task or other errors
            if (err.name === 'CastError') {
                res.status(404).json({ message: "Task not found", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    });

    return router;
};
