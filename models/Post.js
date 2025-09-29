// models/Post.js - New Mongoose model for community posts

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const postSchema = new Schema({
    author: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 100
    },
    content: {
        type: String,
        required: true,
        maxlength: 2000
    },
    comments: [{
        type: Schema.Types.ObjectId,
        ref: 'Comment'
    }]
}, {
    timestamps: true
});

const Post = mongoose.model('Post', postSchema);

module.exports = Post;
