document.addEventListener('DOMContentLoaded', function() {
  const commentsList = document.getElementById('hn-comments-list');
  const hnItemId = document.getElementById('hn-comments').getAttribute('data-hn-item-id');
  const commentsMap = {};
  const pagesToFetch = 3; // Number of pages to fetch

  function fetchComments(page) {
    return fetch(`https://hn.algolia.com/api/v1/search?tags=comment,story_${hnItemId}&page=${page}`)
      .then(response => response.json());
  }

  function processComments(data) {
    // Clear the "Loading comments..." text
    commentsList.innerHTML = '';

    if (data.hits.length === 0) {
      document.getElementById('no-comments-message').style.display = 'block';
      return;
    }
    // First pass: Create a map of comments by ID
    data.hits.forEach(comment => {
      comment.children = [];
      commentsMap[comment.objectID] = comment;
    });

    // Second pass: Organize comments into a tree structure
    data.hits.forEach(comment => {
      if (comment.parent_id !== comment.story_id && commentsMap[comment.parent_id]) {
        commentsMap[comment.parent_id].children.push(comment);
      } else {
        commentsList.appendChild(createCommentElement(comment, 0));
      }
    });
  }

  function loadComments(pagesLeft, page) {
    if (pagesLeft > 0) {
      fetchComments(page)
        .then(data => {
          processComments(data);
          if (page < Math.min(pagesToFetch, data.nbPages) - 1) { // Fetch next page if there are more pages
            loadComments(pagesLeft - 1, page + 1);
          }
        })
        .catch(error => {
          commentsList.innerHTML = 'Error loading comments. Please try again later.';
          console.error('Error fetching comments:', error);
        });
    }
  }

  // Start fetching comments from page 0
  loadComments(pagesToFetch, 0);

  function createCommentElement(comment, depth) {
    const commentDiv = document.createElement('div');
    commentDiv.className = 'hn-comment';
    commentDiv.style.marginLeft = `${depth * 10}px`; // Indent nested comments
    commentDiv.innerHTML = `
      <p><strong><a href="https://news.ycombinator.com/user?id=${comment.author}" target="_blank">${comment.author}</a></strong> | ${new Date(comment.created_at).toLocaleString()}</p>
      <p>${comment.comment_text}</p>
    `;

    if (comment.children.length > 0) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'hn-comment-children';
      comment.children.forEach(child => {
        childrenDiv.appendChild(createCommentElement(child, depth + 1));
      });
      commentDiv.appendChild(childrenDiv);
    }

    return commentDiv;
  }
});
