// models/Comment.js - New Mongoose model for post comments

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const commentSchema = new Schema({
    author: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    post: {
        type: Schema.Types.ObjectId,
        ref: 'Post',
        required: true
    },
    content: {
        type: String,
        required: true,
        maxlength: 500
    },
}, {
    timestamps: true
});

const Comment = mongoose.model('Comment', commentSchema);

module.exports = Comment;
