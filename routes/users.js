var User = require('../models/user');
var Task = require('../models/task');
var mongoose = require('mongoose');

module.exports = function (router) {

    // Collection route
    var usersRoute = router.route('/users');

    // GET /api/users - Get all users with query parameters
    usersRoute.get(function (req, res) {
        try {
            // Parse query parameters
            var whereQuery = req.query.where ? JSON.parse(req.query.where) : {};
            var sortQuery = req.query.sort ? JSON.parse(req.query.sort) : {};
            var selectQuery = req.query.select ? JSON.parse(req.query.select) : {};
            var skipNum = req.query.skip ? parseInt(req.query.skip) : 0;
            var limitNum = req.query.limit ? parseInt(req.query.limit) : 0; // 0 means no limit
            var countQuery = req.query.count === 'true';

            // Build the query
            var query = User.find(whereQuery);

            // Apply select
            if (Object.keys(selectQuery).length > 0) {
                query = query.select(selectQuery);
            }

            // Apply sort
            if (Object.keys(sortQuery).length > 0) {
                query = query.sort(sortQuery);
            }

            // Apply skip and limit
            query = query.skip(skipNum);
            if (limitNum > 0) {
                query = query.limit(limitNum);
            }

            // Execute count or find
            if (countQuery) {
                User.countDocuments(whereQuery).then(function (count) {
                    res.status(200).json({ message: "OK", data: count });
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            } else {
                query.exec().then(function (users) {
                    res.status(200).json({ message: "OK", data: users });
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            }
        } catch (err) {
            res.status(400).json({ message: err.message || "Invalid query parameters", data: {} });
        }
    });

    // POST /api/users - Create a new user
    usersRoute.post(function (req, res) {
        // Validate required fields
        if (!req.body.name || !req.body.email) {
            return res.status(400).json({ message: "Name and email are required", data: {} });
        }

        // Disallow creation requests that include any pendingTasks field (even an empty array)
        // Clients must not provide pendingTasks at creation time — they should be added via task creation or assignment flows.
        if (Object.prototype.hasOwnProperty.call(req.body, 'pendingTasks')) {
            return res.status(400).json({ message: "Users cannot be created with pending tasks", data: {} });
        }

        var user = new User();
        user.name = req.body.name;
        user.email = req.body.email;
        user.pendingTasks = [];

        user.save().then(function (savedUser) {
            res.status(201).json({ message: "Created", data: savedUser });
        }).catch(function (err) {
            if (err.code === 11000) {
                // Duplicate email error
                res.status(400).json({ message: "Email already exists", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    });

    // Individual user route
    var userRoute = router.route('/users/:id');

    // GET /api/users/:id - Get a specific user
    userRoute.get(function (req, res) {
        try {
            var selectQuery = req.query.select ? JSON.parse(req.query.select) : {};
            
            var query = User.findById(req.params.id);
            
            // Apply select if provided
            if (Object.keys(selectQuery).length > 0) {
                query = query.select(selectQuery);
            }

            query.exec().then(function (user) {
                if (!user) {
                    return res.status(404).json({ message: "User not found", data: {} });
                }
                res.status(200).json({ message: "OK", data: user });
            }).catch(function (err) {
                // Invalid ObjectId format or other database errors should return 404
                if (err.name === 'CastError') {
                    res.status(404).json({ message: "User not found", data: {} });
                } else {
                    res.status(500).json({ message: "Internal server error", data: {} });
                }
            });
        } catch (err) {
            res.status(400).json({ message: err.message || "Invalid query parameters", data: {} });
        }
    });

    // PUT /api/users/:id - Replace a user
    userRoute.put(function (req, res) {
        // Validate required fields
        if (!req.body.name || !req.body.email) {
            return res.status(400).json({ message: "Name and email are required", data: {} });
        }

        User.findById(req.params.id).then(function (user) {
            if (!user) {
                return res.status(404).json({ message: "User not found", data: {} });
            }

            var oldPendingTasks = user.pendingTasks || [];
            // Only treat pendingTasks as an update when the client provides the field.
            var pendingTasksProvided = Object.prototype.hasOwnProperty.call(req.body, 'pendingTasks');
            var newPendingTasks = pendingTasksProvided ? (req.body.pendingTasks || []) : undefined;

            // If client provided pendingTasks, validate that all task IDs in newPendingTasks exist and are not completed
            if (pendingTasksProvided && newPendingTasks.length > 0) {
                // Validate each provided id is a valid ObjectId to avoid CastError in queries
                for (var i = 0; i < newPendingTasks.length; i++) {
                    if (!mongoose.Types.ObjectId.isValid(newPendingTasks[i])) {
                        return res.status(400).json({ message: "One or more task IDs are invalid", data: {} });
                    }
                }

                Task.find({ _id: { $in: newPendingTasks } }).then(function (tasks) {
                    if (tasks.length !== newPendingTasks.length) {
                        return res.status(400).json({ message: "One or more task IDs do not exist", data: {} });
                    }

                    // Check if any task is completed
                    var completedTask = tasks.find(function(task) { return task.completed; });
                    if (completedTask) {
                        return res.status(400).json({ message: "Cannot modify completed tasks", data: {} });
                    }

                    // All tasks exist and are not completed, proceed with update
                    updateUserWithTasks(user, oldPendingTasks, newPendingTasks, req, res);
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            } else {
                // No new tasks to validate (either none provided or empty array). Proceed with update.
                updateUserWithTasks(user, oldPendingTasks, newPendingTasks, req, res);
            }
        }).catch(function (err) {
            // Invalid ObjectId for user or other errors
            if (err.name === 'CastError') {
                res.status(404).json({ message: "User not found", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    });

    // Helper function to update user with tasks
    function updateUserWithTasks(user, oldPendingTasks, newPendingTasks, req, res) {
        // Update user fields
        var nameChanged = user.name !== req.body.name;
        user.name = req.body.name;
        user.email = req.body.email;
        // Only overwrite pendingTasks if the client provided the field
        if (typeof newPendingTasks !== 'undefined') {
            user.pendingTasks = (newPendingTasks || []).map(function (v) { return v.toString(); })
                .filter(function (v, i, a) { return a.indexOf(v) === i; });
        }

        // Save the updated user
        user.save().then(function (updatedUser) {
            // Handle two-way consistency: update tasks
            var promises = [];

            // If user name changed, update assignedUserName on ALL tasks assigned to this user
            if (nameChanged) {
                promises.push(
                    Task.updateMany(
                        { assignedUser: req.params.id },
                        { assignedUserName: updatedUser.name }
                    )
                );
            }

            if (typeof newPendingTasks !== 'undefined') {
                var tasksToRemove = oldPendingTasks.filter(function (taskId) {
                    return newPendingTasks.indexOf(taskId) === -1;
                });
                var tasksToAdd = newPendingTasks.filter(function (taskId) {
                    return oldPendingTasks.indexOf(taskId) === -1;
                });

                // Remove user from tasks no longer in pendingTasks
                tasksToRemove.forEach(function (taskId) {
                    promises.push(
                        Task.findById(taskId).then(function (task) {
                            if (task && task.assignedUser === req.params.id) {
                                task.assignedUser = "";
                                task.assignedUserName = "unassigned";
                                return task.save();
                            }
                        })
                    );
                });

                // Add user to newly added tasks
                tasksToAdd.forEach(function (taskId) {
                    promises.push(
                        Task.findById(taskId).then(function (task) {
                            if (task) {
                                var oldTaskUser = task.assignedUser;
                                
                                // If task was assigned to another user, remove from that user's pendingTasks
                                if (oldTaskUser && oldTaskUser !== "" && oldTaskUser !== req.params.id) {
                                    return User.findById(oldTaskUser).then(function (otherUser) {
                                        if (otherUser) {
                                            var index = otherUser.pendingTasks.indexOf(taskId);
                                            if (index > -1) {
                                                otherUser.pendingTasks.splice(index, 1);
                                            }
                                            return otherUser.save();
                                        }
                                    }).then(function () {
                                        // Now update the task
                                        task.assignedUser = req.params.id;
                                        task.assignedUserName = updatedUser.name;
                                        return task.save();
                                    });
                                } else {
                                    // No previous user, just update the task
                                    task.assignedUser = req.params.id;
                                    task.assignedUserName = updatedUser.name;
                                    return task.save();
                                }
                            }
                        })
                    );
                });
            }

            Promise.all(promises).then(function () {
                // Save user again in case pendingTasks was modified for completed tasks
                return updatedUser.save();
            }).then(function (finalUser) {
                res.status(200).json({ message: "OK", data: finalUser });
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        }).catch(function (err) {
            if (err.code === 11000) {
                res.status(400).json({ message: "Email already exists", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    }

    // DELETE /api/users/:id - Delete a user
    userRoute.delete(function (req, res) {
        User.findById(req.params.id).then(function (user) {
            if (!user) {
                return res.status(404).json({ message: "User not found", data: {} });
            }

            var pendingTasks = user.pendingTasks || [];

            // Delete the user
            User.findByIdAndDelete(req.params.id).then(function () {
                // Unassign all tasks that were assigned to this user
                var promises = pendingTasks.map(function (taskId) {
                    return Task.findById(taskId).then(function (task) {
                        if (task && task.assignedUser === req.params.id) {
                            task.assignedUser = "";
                            task.assignedUserName = "unassigned";
                            return task.save();
                        }
                        // Return resolved promise if task not found or doesn't match
                        return Promise.resolve();
                    }).catch(function (err) {
                        // If task lookup fails, still continue (task might be deleted)
                        return Promise.resolve();
                    });
                });

                Promise.all(promises).then(function () {
                    res.status(204).send();
                }).catch(function (err) {
                    res.status(500).json({ message: "Internal server error", data: {} });
                });
            }).catch(function (err) {
                res.status(500).json({ message: "Internal server error", data: {} });
            });
        }).catch(function (err) {
            // Invalid ObjectId or other errors
            if (err.name === 'CastError') {
                res.status(404).json({ message: "User not found", data: {} });
            } else {
                res.status(500).json({ message: "Internal server error", data: {} });
            }
        });
    });

    return router;
};
